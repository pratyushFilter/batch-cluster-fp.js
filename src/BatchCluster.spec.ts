import { env } from "process"
import { inspect } from "util"

import {
  currentTestPids,
  expect,
  parser,
  parserErrors,
  processFactory,
  procs,
  setFailrate,
  setIgnoreExit,
  setNewline,
  shutdown,
  testPids,
  times
} from "./_chai.spec"
import { flatten, sortNumeric } from "./Array"
import { delay } from "./Async"
import { BatchCluster } from "./BatchCluster"
import { BatchClusterOptions } from "./BatchClusterOptions"
import { logger } from "./Logger"
import { map } from "./Object"
import { toS } from "./String"
import { Task } from "./Task"

describe("BatchCluster", function() {
  this.timeout(10000)
  const ErrorPrefix = "ERROR: "

  // Unflake Appveyor:
  if (env.APPVEYOR === "true") this.retries(3)

  function runTasks(
    bc: BatchCluster,
    iterations: number,
    start = 0
  ): Promise<string>[] {
    return times(iterations, i =>
      bc
        .enqueueTask(new Task("upcase abc " + (i + start), parser))
        .catch(err => ErrorPrefix + err)
    )
  }

  function assertExpectedResults(results: string[]) {
    const dataResults = flatten(
      events.taskData.map(ea => ea.data.split(/[\n\r]+/))
    )

    results.forEach((result, index) => {
      if (!result.startsWith(ErrorPrefix)) {
        expect(result).to.eql("ABC " + index)
        expect(dataResults).to.include(result)
      }
    })
  }

  class Events {
    readonly taskData: { cmd?: string; data: string }[] = []
    readonly events: { event: string }[] = []
    readonly startedPids: number[] = []
    readonly exittedPids: number[] = []
    readonly startErrors: Error[] = []
    readonly endErrors: Error[] = []
    readonly internalErrors: Error[] = []
    readonly taskErrors: Error[] = []
  }

  let events = new Events()

  beforeEach(() => {
    events = new Events()
  })

  afterEach(() => {
    expect(events.internalErrors).to.eql([], "internal errors")
  })

  const expectedEndEvents = [{ event: "beforeEnd" }, { event: "end" }]

  function listen(bc: BatchCluster) {
    // This is a typings verification, too:
    bc.on("childStart", cp => events.startedPids.push(cp.pid))
    bc.on("childExit", cp => events.exittedPids.push(cp.pid))
    bc.on("startError", err => events.startErrors.push(err))
    bc.on("endError", err => events.endErrors.push(err))
    bc.on("internalError", err => {
      logger().warn("BatchCluster.spec listen(): internal error: " + err)
      events.internalErrors.push(err)
    })
    bc.on("taskData", (data, task) =>
      events.taskData.push({
        cmd: map(task, ea => ea.command),
        data: toS(data)
      })
    )
    bc.on("taskError", err => events.taskErrors.push(err))

    const emptyEvents = ["beforeEnd", "end"]
    emptyEvents.forEach(event =>
      bc.on("beforeEnd", () => events.events.push({ event }))
    )
    return bc
  }

  const defaultOpts = Object.freeze({
    ...new BatchClusterOptions(),
    maxProcs: 4, // < force concurrency
    versionCommand: "version",
    pass: "PASS",
    fail: "FAIL",
    exitCommand: "exit",
    onIdleIntervalMillis: 250, // frequently to speed up tests
    maxTasksPerProcess: 5, // force process churn
    spawnTimeoutMillis: 2000, // windows is slow
    taskTimeoutMillis: 200, // so the timeout test doesn't timeout
    maxReasonableProcessFailuresPerMinute: 2000, // this is so high because failrate is so high
    streamFlushMillis: 20 // windows is slow
  })
  ;["lf", "crlf"].forEach(newline =>
    [1, 4].forEach(maxProcs =>
      [false, true].forEach(ignoreExit =>
        describe(
          inspect(
            { newline, maxProcs, ignoreExit },
            { colors: true, breakLength: 100 }
          ),
          function() {
            let bc: BatchCluster
            const opts = {
              ...defaultOpts,
              maxProcs
            }

            // failrate needs to be high enough to trigger but low enough to allow
            // retries to succeed.

            beforeEach(() => {
              setNewline(newline as any)
              setIgnoreExit(ignoreExit)
              bc = listen(new BatchCluster({ ...opts, processFactory }))
              procs.length = 0
            })

            afterEach(async () => {
              expect(await shutdown(bc)).to.eql(true)
              expect(bc.internalErrorCount).to.eql(0)
              return
            })

            it("calling .end() when new no-ops", async () => {
              await bc.end()
              expect(bc.ended).to.eql(true)
              expect((await bc.pids()).length).to.eql(0)
              expect(bc.spawnedProcs).to.eql(0)
              expect(events.events).to.eql(expectedEndEvents)
              expect(testPids()).to.eql([])
              expect(events.startedPids).to.eql([])
              expect(events.exittedPids).to.eql([])
              return
            })

            it("calling .end() after running shuts down child procs", async () => {
              // This just warms up bc to make child procs:
              const iterations = maxProcs * 2
              setFailrate(25) // 25%

              const tasks = await Promise.all(runTasks(bc, iterations))
              assertExpectedResults(tasks)
              expect(await shutdown(bc)).to.eql(true)
              expect(bc.spawnedProcs).to.be.within(maxProcs, iterations + 1)
              const pids = sortNumeric(testPids())
              expect(pids.length).to.be.gte(maxProcs)
              expect(sortNumeric(events.startedPids)).to.eql(pids)
              expect(sortNumeric(events.exittedPids)).to.eql(pids)
              expect(events.events).to.eql(expectedEndEvents)
              return
            })

            it(
              "runs a given batch process roughly " +
                opts.maxTasksPerProcess +
                " before recycling",
              async () => {
                // make sure we hit an EUNLUCKY:
                setFailrate(50) // 25%
                let expectedResultCount = 0
                const results = await Promise.all(runTasks(bc, maxProcs))
                expectedResultCount += maxProcs
                const pids = await bc.pids()
                const iters = Math.floor(
                  maxProcs * opts.maxTasksPerProcess * 1.5
                )
                results.push(
                  ...(await Promise.all(
                    runTasks(bc, iters, expectedResultCount)
                  ))
                )
                expectedResultCount += iters
                assertExpectedResults(results)
                expect(results.length).to.eql(expectedResultCount)
                // And expect some errors:
                const errorResults = results.filter(ea =>
                  ea.startsWith(ErrorPrefix)
                )
                expect(errorResults).to.not.eql([])

                // Expect a reasonable number of new pids. Worst case, we
                // errored after every start, so there may be more then iters
                // pids spawned.
                expect(procs.length).to.eql(bc.spawnedProcs)
                expect(bc.spawnedProcs).to.be.within(
                  results.length / opts.maxTasksPerProcess,
                  results.length
                )

                // Expect no prior pids to remain, as long as there were before-pids:
                if (pids.length > 0)
                  expect(await bc.pids()).to.not.include.members(pids)

                expect(bc.spawnedProcs).to.be.within(maxProcs, results.length)
                expect(bc.meanTasksPerProc).to.be.within(
                  0.5, // because flaky
                  opts.maxTasksPerProcess
                )
                expect((await bc.pids()).length).to.be.lte(maxProcs)
                expect((await currentTestPids()).length).to.be.lte(
                  bc.spawnedProcs
                ) // because flaky
                expect(await shutdown(bc)).to.eql(true)
                return
              }
            )

            it("recovers from invalid commands", async () => {
              assertExpectedResults(
                await Promise.all(runTasks(bc, maxProcs * 4))
              )
              const errorResults = await Promise.all(
                times(maxProcs * 2, () =>
                  bc.enqueueTask(new Task("nonsense", parser)).catch(err => err)
                )
              )
              expect(
                errorResults.some(ea => String(ea).includes("nonsense"))
              ).to.eql(true, JSON.stringify(errorResults))
              expect(parserErrors.some(ea => ea.includes("nonsense"))).to.eql(
                true,
                JSON.stringify(parserErrors)
              )
              parserErrors.length = 0
              // BC should recover:
              assertExpectedResults(
                await Promise.all(runTasks(bc, maxProcs * 4))
              )
              return
            })

            it("times out slow requests", async () => {
              const task = new Task(
                "sleep " + (opts.taskTimeoutMillis + 250), // < make sure it times out
                parser
              )
              return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
                /timeout|EUNLUCKY/
              )
            })

            it("rejects a command that results in FAIL", async function() {
              const task = new Task("invalid command", parser)
              let error: Error | undefined
              let result: string = ""
              try {
                result = await bc.enqueueTask(task)
              } catch (err) {
                error = err
              }
              expect(String(error)).to.match(/invalid command|UNLUCKY/, result)
              return
              // return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            })

            it("rejects a command that emits to stderr", async function() {
              const task = new Task("stderr omg this should fail", parser)
              let error: Error | undefined
              let result: string = ""
              try {
                result = await bc.enqueueTask(task)
              } catch (err) {
                error = err
              }
              expect(String(error)).to.match(
                /omg this should fail|UNLUCKY/,
                result
              )
              return
              // return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            })
          }
        )
      )
    )
  )

  describe("maxProcAgeMillis", () => {
    const opts = {
      ...defaultOpts,
      maxProcs: 4,
      maxTasksPerProcess: 100,
      spawnTimeoutMillis: 1000, // maxProcAge must be >= this
      maxProcAgeMillis: 1000
    }

    let bc: BatchCluster

    beforeEach(
      () =>
        (bc = listen(
          new BatchCluster({
            ...opts,
            processFactory
          })
        ))
    )

    afterEach(async () => {
      expect(await shutdown(bc)).to.eql(true)
      expect(bc.internalErrorCount).to.eql(0)
      return
    })

    it("culls old child procs", async () => {
      assertExpectedResults(
        await Promise.all(runTasks(bc, opts.maxProcs + 100))
      )
      expect((await bc.pids()).length).to.be.within(1, opts.maxProcs)
      await delay(opts.maxProcAgeMillis)
      // Calling .pids calls .procs(), which culls old procs
      expect((await bc.pids()).length).to.be.within(0, opts.maxProcs)
      return
    })
  })

  describe("opts parsing", () => {
    function errToArr(err: any) {
      return err
        .toString()
        .split(/[:,]/)
        .map((ea: string) => ea.trim())
    }

    it("requires maxProcAgeMillis to be > spawnTimeoutMillis", () => {
      const spawnTimeoutMillis = defaultOpts.taskTimeoutMillis + 1
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          ...defaultOpts,
          spawnTimeoutMillis,
          maxProcAgeMillis: spawnTimeoutMillis - 1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            spawnTimeoutMillis
        ])
      }
    })

    it("requires maxProcAgeMillis to be > taskTimeoutMillis", () => {
      const taskTimeoutMillis = defaultOpts.spawnTimeoutMillis + 1
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          ...defaultOpts,
          taskTimeoutMillis,
          maxProcAgeMillis: taskTimeoutMillis - 1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            taskTimeoutMillis
        ])
      }
    })

    it("reports on invalid opts", () => {
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          versionCommand: "",
          pass: "",
          fail: "",

          spawnTimeoutMillis: 50,
          taskTimeoutMillis: 5,
          maxTasksPerProcess: 0,

          maxProcs: -1,
          maxProcAgeMillis: -1,
          onIdleIntervalMillis: -1,
          endGracefulWaitTimeMillis: -1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "versionCommand must not be blank",
          "pass must not be blank",
          "fail must not be blank",
          "spawnTimeoutMillis must be greater than or equal to 100",
          "taskTimeoutMillis must be greater than or equal to 10",
          "maxTasksPerProcess must be greater than or equal to 1",
          "maxProcs must be greater than or equal to 1",
          "maxProcAgeMillis must be greater than or equal to 50",
          "onIdleIntervalMillis must be greater than or equal to 0",
          "endGracefulWaitTimeMillis must be greater than or equal to 0"
        ])
      }
    })
  })
})
