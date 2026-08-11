import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Discover agent skills (SKILL.md) in default local coding-agent locations.
 * Deduplicates by resolved real path; same skill name at different paths is kept once
 * (first match wins — project-local roots preferred over home).
 */

const MAX_SCAN_DEPTH = 3;

/**
 * Standard skill roots used by Claude Code, Cursor, Codex, Grok, agents CLI, etc.
 * Project roots are listed first so local skills win on name collisions.
 */
export function defaultSkillSearchRoots({
  projectRoot = null,
  home = os.homedir(),
} = {}) {
  const homeRoots = [
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".cursor", "skills-cursor"),
    path.join(home, ".grok", "skills"),
    path.join(home, ".grok", "bundled", "skills"),
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".config", "agents", "skills"),
  ];

  const projectRoots = [];
  if (projectRoot) {
    const root = path.resolve(projectRoot);
    projectRoots.push(
      path.join(root, ".agents", "skills"),
      path.join(root, ".claude", "skills"),
      path.join(root, ".cursor", "skills"),
      path.join(root, ".grok", "skills"),
      path.join(root, "skills"),
      path.join(root, ".github", "skills"),
    );
  }

  return [...projectRoots, ...homeRoots];
}

/**
 * List unique skills under default (or provided) roots.
 *
 * @returns {Promise<Array<{ name: string, path: string, dir: string, description: string, source: string }>>}
 */
export async function listRemoteSkills({
  projectRoot = null,
  home = os.homedir(),
  roots = null,
} = {}) {
  const searchRoots = roots || defaultSkillSearchRoots({ projectRoot, home });
  /** @type {Map<string, { name: string, path: string, dir: string, description: string, source: string }>} */
  const byRealPath = new Map();
  /** @type {Set<string>} */
  const claimedNames = new Set();

  for (const root of searchRoots) {
    const skillFiles = await findSkillMarkdownFiles(root, MAX_SCAN_DEPTH);
    for (const skillPath of skillFiles) {
      let resolved;
      try {
        resolved = await realpath(skillPath);
      } catch {
        resolved = path.resolve(skillPath);
      }
      if (byRealPath.has(resolved)) {
        continue;
      }

      const meta = await parseSkillFile(skillPath);
      const name = meta.name || path.basename(path.dirname(skillPath));
      // Name-level dedupe: first root wins (project over home)
      if (claimedNames.has(name)) {
        continue;
      }
      claimedNames.add(name);
      byRealPath.set(resolved, {
        name,
        path: resolved,
        dir: path.dirname(resolved),
        description: meta.description || "",
        source: root,
      });
    }
  }

  return [...byRealPath.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * Read a skill by name or absolute/relative path to SKILL.md or skill dir.
 */
export async function readRemoteSkill(nameOrPath, options = {}) {
  const query = String(nameOrPath || "").trim();
  if (!query) {
    throw new Error("Skill name or path is required.");
  }

  const skills = await listRemoteSkills(options);

  // Exact name match (case-insensitive)
  const byName = skills.find((s) => s.name.toLowerCase() === query.toLowerCase());
  if (byName) {
    const content = await readFile(byName.path, "utf8");
    return { ...byName, content };
  }

  // Path match (absolute or as listed)
  const resolvedQuery = path.resolve(query);
  const byPath = skills.find(
    (s) =>
      s.path === query ||
      s.path === resolvedQuery ||
      s.dir === query ||
      s.dir === resolvedQuery ||
      path.basename(s.dir) === query,
  );
  if (byPath) {
    const content = await readFile(byPath.path, "utf8");
    return { ...byPath, content };
  }

  // Direct filesystem path (even if outside scanned roots) when it looks like a skill
  const direct = await tryReadDirectSkillPath(query);
  if (direct) {
    return direct;
  }

  const available = skills.map((s) => s.name).slice(0, 30);
  const hint =
    available.length > 0
      ? ` Known skills: ${available.join(", ")}${skills.length > 30 ? ", …" : ""}.`
      : " No skills found in default locations.";
  throw new Error(`Skill not found: ${query}.${hint} Call list_remote_skills first.`);
}

/**
 * Human-readable list for the model.
 */
export function formatSkillsList(skills) {
  if (!skills || skills.length === 0) {
    return [
      "No agent skills found in default locations.",
      "",
      "Searched typical roots under the project and home:",
      "  .agents/skills, .claude/skills, .cursor/skills, .grok/skills,",
      "  ~/.agents/skills, ~/.claude/skills, ~/.codex/skills, ~/.cursor/skills,",
      "  ~/.grok/skills, ~/.grok/bundled/skills, …",
      "",
      "A skill is a directory containing SKILL.md (Agent Skills format).",
    ].join("\n");
  }

  const lines = [
    `Found ${skills.length} skill${skills.length === 1 ? "" : "s"} (deduplicated by path and name).`,
    "Use read_remote_skill with the skill name (or path) to load full SKILL.md contents.",
    "",
  ];

  for (const skill of skills) {
    const desc = skill.description
      ? skill.description.replace(/\s+/g, " ").trim()
      : "(no description)";
    lines.push(`- ${skill.name}`);
    lines.push(`  path: ${skill.path}`);
    lines.push(`  description: ${desc}`);
  }

  return lines.join("\n");
}

async function tryReadDirectSkillPath(query) {
  const candidates = [];
  const resolved = path.resolve(query);
  candidates.push(resolved);
  if (!resolved.endsWith("SKILL.md")) {
    candidates.push(path.join(resolved, "SKILL.md"));
  }

  for (const candidate of candidates) {
    try {
      const st = await stat(candidate);
      if (!st.isFile()) {
        continue;
      }
      const base = path.basename(candidate);
      if (base.toLowerCase() !== "skill.md") {
        continue;
      }
      const content = await readFile(candidate, "utf8");
      const meta = parseSkillFrontmatter(content);
      let resolvedPath = candidate;
      try {
        resolvedPath = await realpath(candidate);
      } catch {
        // keep candidate
      }
      return {
        name: meta.name || path.basename(path.dirname(resolvedPath)),
        path: resolvedPath,
        dir: path.dirname(resolvedPath),
        description: meta.description || "",
        source: path.dirname(path.dirname(resolvedPath)),
        content,
      };
    } catch {
      // try next
    }
  }
  return null;
}

async function findSkillMarkdownFiles(root, maxDepth) {
  const results = [];
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return results;
  }
  if (!rootStat.isDirectory()) {
    return results;
  }

  await walk(root, 0, maxDepth, results);
  return results;
}

async function walk(dir, depth, maxDepth, results) {
  if (depth > maxDepth) {
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name === "node_modules" || name === ".git" || name === ".tmp") {
      continue;
    }
    const full = path.join(dir, name);
    if (entry.isFile() && name.toLowerCase() === "skill.md") {
      results.push(full);
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await walk(full, depth + 1, maxDepth, results);
    } else if (entry.isSymbolicLink()) {
      // Follow skill package symlinks one level (common for linked skills)
      try {
        const st = await stat(full);
        if (st.isDirectory() && depth < maxDepth) {
          await walk(full, depth + 1, maxDepth, results);
        } else if (st.isFile() && name.toLowerCase() === "skill.md") {
          results.push(full);
        }
      } catch {
        // broken link
      }
    }
  }
}

async function parseSkillFile(skillPath) {
  try {
    const content = await readFile(skillPath, "utf8");
    return parseSkillFrontmatter(content);
  } catch {
    return { name: "", description: "" };
  }
}

/**
 * Parse YAML-ish frontmatter for name + description only (no full YAML dep).
 */
export function parseSkillFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---")) {
    return { name: "", description: "" };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { name: "", description: "" };
  }
  const block = text.slice(3, end).replace(/^\r?\n/, "");
  const name = matchFrontmatterField(block, "name");
  const description = matchFrontmatterField(block, "description");
  return { name: name || "", description: description || "" };
}

function matchFrontmatterField(block, field) {
  // name: value  OR  name: "value"  OR multi-line not supported beyond single line
  const re = new RegExp(`^${field}\\s*:\\s*(.*)$`, "mi");
  const match = block.match(re);
  if (!match) {
    return "";
  }
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Fold accidental trailing comments
  return value.trim();
}
