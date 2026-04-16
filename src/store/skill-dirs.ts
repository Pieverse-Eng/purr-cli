import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const home = homedir()
const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude')

export const UNIVERSAL_LOCAL = '.agents/skills'
export const UNIVERSAL_GLOBAL = join(configHome, 'agents/skills')

// [name, localSkillsDir, globalSkillsDir, detectDir]
const ADDITIONAL: [string, string, string, string][] = [
  ['Augment',       '.augment/skills',     join(home, '.augment/skills'),              '.augment'],
  ['IBM Bob',       '.bob/skills',         join(home, '.bob/skills'),                  '.bob'],
  ['Claude Code',   '.claude/skills',      join(claudeHome, 'skills'),                 '.claude'],
  ['OpenClaw',      'skills',              join(home, '.openclaw/skills'),              '.openclaw'],
  ['CodeBuddy',     '.codebuddy/skills',   join(home, '.codebuddy/skills'),             '.codebuddy'],
  ['Command Code',  '.commandcode/skills', join(home, '.commandcode/skills'),           '.commandcode'],
  ['Continue',      '.continue/skills',    join(home, '.continue/skills'),              '.continue'],
  ['Cortex',        '.cortex/skills',      join(home, '.snowflake/cortex/skills'),      '.cortex'],
  ['Crush',         '.crush/skills',       join(home, '.config/crush/skills'),          '.crush'],
  ['Droid',         '.factory/skills',     join(home, '.factory/skills'),               '.factory'],
  ['Goose',         '.goose/skills',       join(configHome, 'goose/skills'),            '.goose'],
  ['Junie',         '.junie/skills',       join(home, '.junie/skills'),                 '.junie'],
  ['iFlow CLI',     '.iflow/skills',       join(home, '.iflow/skills'),                 '.iflow'],
  ['Kilo',          '.kilocode/skills',    join(home, '.kilocode/skills'),              '.kilocode'],
  ['Kiro CLI',      '.kiro/skills',        join(home, '.kiro/skills'),                  '.kiro'],
  ['Kode',          '.kode/skills',        join(home, '.kode/skills'),                  '.kode'],
  ['MCPJam',        '.mcpjam/skills',      join(home, '.mcpjam/skills'),               '.mcpjam'],
  ['Mistral Vibe',  '.vibe/skills',        join(home, '.vibe/skills'),                  '.vibe'],
  ['Mux',           '.mux/skills',         join(home, '.mux/skills'),                   '.mux'],
  ['OpenHands',     '.openhands/skills',   join(home, '.openhands/skills'),             '.openhands'],
  ['Pi',            '.pi/skills',          join(home, '.pi/agent/skills'),              '.pi'],
  ['Qoder',         '.qoder/skills',       join(home, '.qoder/skills'),                 '.qoder'],
  ['Qwen Code',     '.qwen/skills',        join(home, '.qwen/skills'),                  '.qwen'],
  ['Replit',        '.agents/skills',      join(configHome, 'agents/skills'),           '.replit'],
  ['Roo',           '.roo/skills',         join(home, '.roo/skills'),                   '.roo'],
  ['Trae',          '.trae/skills',        join(home, '.trae/skills'),                  '.trae'],
  ['Trae CN',       '.trae-cn/skills',     join(home, '.trae-cn/skills'),               '.trae-cn'],
  ['Windsurf',      '.windsurf/skills',    join(home, '.codeium/windsurf/skills'),      '.windsurf'],
  ['Zencoder',      '.zencoder/skills',    join(home, '.zencoder/skills'),              '.zencoder'],
  ['Neovate',       '.neovate/skills',     join(home, '.neovate/skills'),               '.neovate'],
  ['Pochi',         '.pochi/skills',       join(home, '.pochi/skills'),                 '.pochi'],
  ['Adal',          '.adal/skills',        join(home, '.adal/skills'),                  '.adal'],
]

export function installToAgents(
  slug: string,
  srcDir: string,
  isGlobal: boolean,
): { installed: { agent: string; path: string }[]; skipped: string[]; errors: { agent: string; reason: string }[] } {
  const cwd = process.cwd()
  const installed: { agent: string; path: string }[] = []
  const skipped: string[] = []
  const errors: { agent: string; reason: string }[] = []
  const written = new Set<string>()

  const universalPath = isGlobal ? join(UNIVERSAL_GLOBAL, slug) : join(cwd, UNIVERSAL_LOCAL, slug)
  try {
    mkdirSync(universalPath, { recursive: true })
    cpSync(srcDir, universalPath, { recursive: true, force: true })
    installed.push({ agent: 'universal', path: universalPath })
    written.add(resolve(universalPath))
  } catch (err) {
    errors.push({ agent: 'universal', reason: (err as Error).message })
  }

  for (const [name, localDir, globalDir, detectDir] of ADDITIONAL) {
    const target = isGlobal ? join(globalDir, slug) : join(cwd, localDir, slug)
    const resolved = resolve(target)

    if (written.has(resolved)) {
      const probe = isGlobal ? join(home, detectDir) : join(cwd, detectDir)
      if (existsSync(probe)) {
        installed.push({ agent: name, path: target })
      }
      continue
    }

    const probe = isGlobal ? join(home, detectDir) : join(cwd, detectDir)
    if (existsSync(probe)) {
      try {
        mkdirSync(target, { recursive: true })
        cpSync(srcDir, target, { recursive: true, force: true })
        installed.push({ agent: name, path: target })
        written.add(resolved)
      } catch (err) {
        errors.push({ agent: name, reason: (err as Error).message })
      }
    } else {
      skipped.push(name)
    }
  }
  return { installed, skipped, errors }
}

export function removeFromAgents(
  slug: string,
  isGlobal: boolean,
): { removed: { agent: string; path: string }[]; notFound: string[] } {
  const cwd = process.cwd()
  const removed: { agent: string; path: string }[] = []
  const notFound: string[] = []

  const universalPath = isGlobal ? join(UNIVERSAL_GLOBAL, slug) : join(cwd, UNIVERSAL_LOCAL, slug)
  if (existsSync(universalPath)) {
    rmSync(universalPath, { recursive: true, force: true })
    removed.push({ agent: 'universal', path: universalPath })
  } else {
    notFound.push('universal')
  }

  const seen = new Set<string>()
  for (const [name, localDir, globalDir] of ADDITIONAL) {
    const target = isGlobal ? join(globalDir, slug) : join(cwd, localDir, slug)
    const resolved = resolve(target)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true })
      removed.push({ agent: name, path: target })
    } else {
      notFound.push(name)
    }
  }
  return { removed, notFound }
}

export function detectAgents(isGlobal: boolean): string[] {
  const cwd = process.cwd()
  const detected = ['universal']
  for (const [name, , , detectDir] of ADDITIONAL) {
    const probe = isGlobal ? join(home, detectDir) : join(cwd, detectDir)
    if (existsSync(probe)) detected.push(name)
  }
  return detected
}
