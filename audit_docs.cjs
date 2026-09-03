#!/usr/bin/env node
/**
 * audit_docs.js — deterministic documentation-coverage check for Netbox, no AI involved.
 *
 * What it does: walks the repo, and for every .js/.ts file (skipping node_modules, .git,
 * dist/build output, and markdown), checks two things per Section 10 of NETBOX_BUILD_SPEC.md:
 *   1. Does the file have a header comment block before its first real line of code?
 *   2. For each exported function/class/const it can find, is there a comment immediately
 *      above the declaration?
 *
 * This is a heuristic, not a real parser — it will occasionally miscount an unusual export
 * pattern. That's a deliberate tradeoff: it needs zero setup (no npm install, no AST
 * library), it is 100% deterministic (same input, same output, every run), and its output
 * is a plain list you can read and verify yourself, not prose from a model that can degrade
 * or pad. Run it, read the list, spot-check a few of the "missing" flags by eye.
 *
 * Usage:
 *   node audit_docs.js [path-to-repo-root]
 * (defaults to the current directory if no path is given)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);
const CODE_EXT = new Set([".js", ".ts", ".mjs", ".cjs"]);

function walk(dir, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error("Could not read directory: " + dir + " (" + e.message + ")");
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (CODE_EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.endsWith("*/");
}

function hasHeaderComment(lines) {
  let i = 0;
  // skip shebang and blank lines
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("#!"))) i++;
  return i < lines.length && (lines[i].trim().startsWith("/**") || lines[i].trim().startsWith("//") || lines[i].trim().startsWith("/*"));
}

// Patterns for a declaration line that plausibly represents an export.
const EXPORT_PATTERNS = [
  /^\s*export\s+function\s+([A-Za-z0-9_$]+)/,
  /^\s*export\s+class\s+([A-Za-z0-9_$]+)/,
  /^\s*export\s+const\s+([A-Za-z0-9_$]+)/,
  /^\s*export\s+async\s+function\s+([A-Za-z0-9_$]+)/,
  /^\s*exports\.([A-Za-z0-9_$]+)\s*=/,
  /^\s*module\.exports\.([A-Za-z0-9_$]+)\s*=/,
];

function findExports(lines) {
  const found = []; // {name, lineIndex}
  lines.forEach((line, idx) => {
    for (const re of EXPORT_PATTERNS) {
      const m = line.match(re);
      if (m) {
        found.push({ name: m[1], lineIndex: idx });
        break;
      }
    }
  });
  return found;
}

function nearestPrecedingIsComment(lines, lineIndex) {
  let i = lineIndex - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return false;
  return isCommentLine(lines[i]);
}

function auditFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const header = hasHeaderComment(lines);
  const exportsFound = findExports(lines);
  const missing = exportsFound.filter((e) => !nearestPrecedingIsComment(lines, e.lineIndex));
  return { header, exportsFound, missing };
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error("Path does not exist: " + ROOT);
    process.exit(1);
  }
  const files = walk(ROOT, []);
  files.sort();

  let filesMissingHeader = 0;
  let totalExports = 0;
  let totalMissingDocs = 0;

  console.log("Documentation audit — " + ROOT);
  console.log("Files scanned: " + files.length);
  console.log("=".repeat(70));

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const { header, exportsFound, missing } = auditFile(file);
    totalExports += exportsFound.length;
    totalMissingDocs += missing.length;
    if (!header) filesMissingHeader++;

    const headerFlag = header ? "OK" : "MISSING HEADER COMMENT";
    console.log("\n" + rel);
    console.log("  header comment: " + headerFlag);
    console.log("  exports found: " + exportsFound.length);
    if (missing.length) {
      console.log("  missing doc comment on: " + missing.map((m) => m.name + " (line " + (m.lineIndex + 1) + ")").join(", "));
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("  files scanned: " + files.length);
  console.log("  files missing a header comment: " + filesMissingHeader);
  console.log("  exported symbols found: " + totalExports);
  console.log("  exported symbols missing a doc comment: " + totalMissingDocs);
  console.log("\nThis is a heuristic scan, not a certified audit — spot-check a few");
  console.log("of the flagged lines yourself before treating this as final.");
}

main();
