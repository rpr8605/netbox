#!/usr/bin/env node
// control-plane/test/compose.security.test.js
// Verifies the local docker-compose.yml hardening required by the 2026-09-23
// independent review (finding C3):
//   - control-plane and step-ca host ports bind 127.0.0.1 only
//   - Postgres is not published to the host at all
//   - POSTGRES_PASSWORD and CA_PASSWORD are required with no defaults
//   - .env.example exists and .env is gitignored
// This test inspects files only; it does not start Docker.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

function serviceBlock(raw, name) {
  // Naive block extractor: find "  <name>:" and return lines until the next
  // top-level service key (two-space indent followed by a word/hyphens + colon) or EOF.
  const start = raw.search(new RegExp(`^  ${name}:`, 'm'));
  if (start === -1) return null;
  const rest = raw.slice(start);
  const afterFirstLine = rest.indexOf('\n');
  const searchFrom = afterFirstLine === -1 ? rest.length : afterFirstLine + 1;
  const next = rest.slice(searchFrom).search(/^ {2}[\w-]+:/m);
  const end = next === -1 ? -1 : searchFrom + next;
  return end === -1 ? rest : rest.slice(0, end);
}

function portsList(serviceBlock) {
  // Extract the list entries under the "ports:" key inside a service block.
  // Port lines are four-space-indented list items: "    - \"127.0.0.1:...\"".
  const lines = serviceBlock.split(/\r?\n/);
  const result = [];
  let inPorts = false;
  for (const line of lines) {
    if (/^ {4}ports:/.test(line)) { inPorts = true; continue; }
    if (inPorts) {
      if (/^ {4}[\w-]+:/.test(line)) break; // next service-level key
      if (/^ {6}- /.test(line)) result.push(line.trim());
    }
  }
  return result;
}

describe('docker-compose security hardening (C3)', () => {
  const raw = fs.readFileSync(COMPOSE_PATH, 'utf8');
  const envExample = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const gitignore = fs.readFileSync(GITIGNORE_PATH, 'utf8');

  it('binds the control-plane host port to 127.0.0.1 only', () => {
    const portLines = portsList(serviceBlock(raw, 'control-plane')).filter(l => l.includes(':9100'));
    assert.ok(portLines.length > 0, 'control-plane must publish port 9100');
    for (const line of portLines) {
      assert.ok(line.startsWith('- "127.0.0.1:') || line.startsWith("- '127.0.0.1:"),
        `control-plane port must bind 127.0.0.1: ${line}`);
    }
  });

  it('binds the step-ca host port to 127.0.0.1 only', () => {
    const portLines = portsList(serviceBlock(raw, 'step-ca')).filter(l => l.includes(':9000'));
    assert.ok(portLines.length > 0, 'step-ca must publish port 9000');
    for (const line of portLines) {
      assert.ok(line.startsWith('- "127.0.0.1:') || line.startsWith("- '127.0.0.1:"),
        `step-ca port must bind 127.0.0.1: ${line}`);
    }
  });

  it('does not publish Postgres to the host', () => {
    const portLines = portsList(serviceBlock(raw, 'postgres'));
    assert.ok(portLines.length === 0, 'postgres must not publish any host port');
  });

  it('requires POSTGRES_PASSWORD with no default', () => {
    assert.match(raw, /\$\{POSTGRES_PASSWORD:\?[^}]+\}/,
      'POSTGRES_PASSWORD must use ${VAR:?message} with no default');
    assert.doesNotMatch(raw, /POSTGRES_PASSWORD:\s*beacon/,
      'compose must not contain a hardcoded POSTGRES_PASSWORD default');
  });

  it('requires CA_PASSWORD with no default', () => {
    assert.match(raw, /\$\{CA_PASSWORD:\?[^}]+\}/,
      'CA_PASSWORD must use ${VAR:?message} with no default');
    assert.doesNotMatch(raw, /CA_PASSWORD:\s*dev-only-insecure-changeit!/,
      'compose must not contain a hardcoded CA_PASSWORD default');
  });

  it('ships an .env.example without committed defaults for secrets', () => {
    assert.ok(fs.existsSync(ENV_EXAMPLE_PATH), '.env.example must exist');
    assert.doesNotMatch(envExample, /^POSTGRES_PASSWORD=.+$/m,
      '.env.example must not set a default POSTGRES_PASSWORD');
    assert.doesNotMatch(envExample, /^CA_PASSWORD=.+$/m,
      '.env.example must not set a default CA_PASSWORD');
  });

  it('gitignores .env and .env.local', () => {
    const lines = gitignore.split(/\r?\n/);
    assert.ok(lines.includes('.env'), '.env must be gitignored');
    assert.ok(lines.includes('.env.local'), '.env.local must be gitignored');
  });
});
