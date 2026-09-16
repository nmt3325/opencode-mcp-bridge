import assert from "node:assert/strict"
import { test } from "node:test"
import { replace } from "../dist/vendor/opencode/edit.js"
import { Patch } from "../dist/vendor/opencode/patch.js"
import { tail } from "../dist/vendor/opencode/shell-output.js"
import { denied } from "../dist/runtime/permissions.js"

test("extracted replacement is literal, supports fuzzy lines, and rejects ambiguity", () => {
  assert.equal(replace("a old z", "old", "$& $1"), "a $& $1 z")
  assert.equal(replace("before\n  value = 1;\nafter", "value = 1;", "value = 2;").includes("value = 2;"), true)
  assert.throws(() => replace("one one", "one", "two"), /multiple|occurrence/i)
  assert.equal(replace("one one", "one", "two", true), "two two")
  assert.equal(replace("one one", "one", "$& $1", true), "$& $1 $& $1")
})

test("extracted patch matching handles context and end-of-file hunks", () => {
  const [hunk] = Patch.parse("*** Begin Patch\n*** Update File: file.txt\n@@\n one\n-two\n+three\n*** End of File\n*** End Patch")
  assert.equal(Patch.derive(hunk.path, hunk.chunks, "one\ntwo\n").content, "one\nthree\n")
  assert.throws(() => Patch.parse("not a patch"), /Invalid patch/)
})

test("extracted output tail never cuts through a UTF-8 character", () => {
  for (let cap = 1; cap < 25; cap++) {
    const output = tail("先頭🙂日本語末尾", 2000, cap)
    assert.ok(Buffer.byteLength(output.text) <= cap)
    assert.ok(!output.text.includes("\uFFFD"))
  }
})

test("delegation and filesystem-escape capabilities stay denied without an approval step", () => {
  for (const permission of ["external_directory", "task", "question"]) assert.equal(denied(permission), true)
  for (const permission of ["read", "write", "edit", "bash", "webfetch", "glob", "grep", "todowrite"]) assert.equal(denied(permission), false)
})
