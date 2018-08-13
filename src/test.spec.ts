import { ChildProcess } from "child_process"

import { until } from "./Async"
import { expect, testProcessFactory } from "./chai.spec"
import { Deferred } from "./Deferred"
import { kill, running } from "./Procs"

describe("test.js", () => {
  class Harness {
    readonly child: ChildProcess
    public output: string = ""
    constructor(env: any = {}) {
      this.child = testProcessFactory({ rngseed: "hello", ...env })
      this.child.on("error", (err: any) => {
        throw err
      })
      this.child.stdout.on("data", (buff: any) => {
        this.output += buff.toString()
      })
    }
    async untilOutput(minLength: number = 0): Promise<void> {
      await until(() => this.output.length > minLength, 1000)
      return
    }
    async end(): Promise<void> {
      this.child.stdin.end(null)
      await until(() => this.running().then(ea => !ea), 1000)
      if (await this.running()) {
        console.error("Ack, I had to kill child pid " + this.child.pid)
        kill(this.child.pid)
      }
      return
    }
    async running(): Promise<boolean> {
      return running(this.child.pid)
    }
    async notRunning(): Promise<boolean> {
      return this.running().then(ea => !ea)
    }
    async assertStdout(expectedOutput: string) {
      expect(await running(this.child.pid)).to.be.true
      const d = new Deferred()
      this.child.on("exit", async () => {
        try {
          expect(this.output.trim()).to.eql(expectedOutput)
          expect(await this.running()).to.be.false
          d.resolve()
        } catch (err) {
          d.reject(err)
        }
      })
      return d.promise
    }
  }

  it("results in expected output", async () => {
    const h = new Harness()
    const a = h.assertStdout("HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS")
    h.child.stdin.end("upcase Hello\ndowncase World\ninvalid input\nversion\n")
    return a
  })

  it("exits properly if ignoreExit is not set", async () => {
    const h = new Harness()
    h.child.stdin.write("upcase fuzzy\nexit\n")
    await h.untilOutput(9)
    expect(h.output).to.eql("FUZZY\nPASS\n")
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.be.false
    return
  })

  it("kill(!force) with ignoreExit set doesn't cause the process to end", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, false)
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.be.true
    return h.end()
  })

  it("kill(!force) with ignoreExit unset causes the process to end", async () => {
    const h = new Harness({ ignoreExit: "0" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.be.false
    return
  })

  it("kill(force) even with ignoreExit set causes the process to end", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.be.false
    return
  })

  it("doesn't exit if ignoreExit is set", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase Boink\nexit\n")
    await h.untilOutput("BOINK\nPASS\nignore".length)
    expect(h.output).to.eql("BOINK\nPASS\nignoreExit is set\n")
    expect(await h.running()).to.be.true
    await h.end()
    expect(await h.running()).to.be.false
    return
  })

  it("returns a valid pid", async () => {
    const h = new Harness()
    expect(await running(h.child.pid)).to.be.true
    await h.end()
    return
  })

  it("sleeps serially", () => {
    const h = new Harness()
    const start = Date.now()
    const a = h
      .assertStdout("slept 200\nPASS\nslept 201\nPASS\nslept 202\nPASS")
      .then(() => expect(Date.now() - start).to.be.gte(603))
    h.child.stdin.end("sleep 200\nsleep 201\nsleep 202\nexit\n")
    return a
  })

  it("flakes out the first N responses", () => {
    const h = new Harness()
    // These random numbers are consistent because we have a consistent rngseed:
    const a = h.assertStdout(
      [
        "flaky response (PASS, r: 0.55, flakeRate: 0.50)",
        "PASS",
        "flaky response (PASS, r: 0.44, flakeRate: 0.00)",
        "PASS",
        "flaky response (FAIL, r: 0.55, flakeRate: 1.00)",
        "FAIL"
      ].join("\n")
    )
    h.child.stdin.end("flaky .5\nflaky 0\nflaky 1\nexit\n")
    return a
  })
})
