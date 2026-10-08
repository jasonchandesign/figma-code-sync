'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** CRLF → LF and no BOM, so a Windows autocrlf checkout hashes like git does. */
const normalizeEol = (text) => String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * Parse a JSON file. `fallback` covers a MISSING file only: a file that exists
 * but does not parse is always an error, because a corrupt map or snapshot
 * silently read as "empty" would let every gate pass.
 */
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(normalizeEol(text));
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
}

/** Stable, diff-friendly JSON: two-space indent and a trailing newline. */
const stringify = (data) => JSON.stringify(data, null, 2) + '\n';

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(data), 'utf8');
}

/** FIGMA_TOKEN, else ~/.figma-token — never a file inside the repo. */
function figmaToken(home = os.homedir()) {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(home, '.figma-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Every file under `dir` whose extension is in `exts`, skipping `ignore` dir names. */
function walkFiles(dir, exts, ignore = ['node_modules', 'build', '.git']) {
  const out = [];
  const visit = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignore.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (exts.includes(path.extname(e.name))) out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Forward-slash path relative to root, for messages and committed JSON. */
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

module.exports = { sha256, normalizeEol, readJson, writeJson, stringify, figmaToken, walkFiles, escapeRe, rel };
