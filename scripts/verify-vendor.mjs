import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { builtinModules } from "node:module"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import { UPSTREAM } from "../dist/config.js"
const manifest = JSON.parse(await readFile("vendor/opencode/UPSTREAM.json", "utf8"))
assert.equal(manifest.commit, UPSTREAM.commit)
assert.equal(manifest.version, UPSTREAM.version)
const listed = new Set()
for (const item of manifest.files) {
  assert.ok(!listed.has(item.file), "duplicate provenance entry: " + item.file)
  listed.add(item.file)
  assert.match(item.sourceSha256, /^[0-9a-f]{64}$/)
  assert.ok(item.changes)
  assert.equal(createHash("sha256").update(await readFile(item.file)).digest("hex"), item.vendoredSha256, "vendor changed without provenance update: " + item.file)
}
async function walk(path) {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(file))
    else if (entry.isFile()) files.push(file)
    else throw new Error("Unexpected symlink/special file: " + file)
  }
  return files
}
for (const path of await walk("src/vendor/opencode")) assert.ok(listed.has(path), "untracked vendored source: " + path)
const pkg = JSON.parse(await readFile("package.json", "utf8"))
const dependencies = Object.keys(pkg.dependencies)
assert.deepEqual(dependencies.filter((name) => /opencode|@ai-sdk|@opentui|^ai$|bun|solid-js/.test(name)), [])
assert.ok(!pkg.scripts["setup:native"])
assert.ok(!pkg.scripts.preinstall && !pkg.scripts.install && !pkg.scripts.postinstall)
// Check actual module edges, not arbitrary words inside tool descriptions.
for (const path of (await walk("src")).filter((file) => file.endsWith(".ts"))) {
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") ? node.arguments[0] : undefined
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text
      if (name.startsWith(".")) assert.ok(resolve(dirname(path), name).startsWith(resolve("src") + "/"), "external source dependency: " + name)
      else assert.ok(builtinModules.includes(name) || name.startsWith("node:") || dependencies.some((dep) => name === dep || name.startsWith(dep + "/")), `undeclared/application dependency in ${path}: ${name}`)
      assert.ok(!/^(?:bun:|@opencode|@ai-sdk|@opentui|ai(?:\/|$))/.test(name), "forbidden runtime dependency: " + name)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
assert.match(await readFile("vendor/opencode/LICENSE", "utf8"), /MIT License/)
console.error(`Verified ${manifest.files.length} extracted source units, provenance hashes and standalone dependency boundary.`)
