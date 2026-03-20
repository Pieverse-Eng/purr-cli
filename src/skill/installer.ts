import { createHash } from 'node:crypto'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, posix, relative } from 'node:path'
import { unzipSync } from 'fflate'
import type { AgentDefinition } from './agents.js'
import { getAgent } from './agents.js'

const home = homedir()

export interface InstallSkillOptions {
	readonly slug: string
	readonly buffer: Buffer
	readonly sha256: string
	readonly scope: 'local' | 'global'
	readonly agents: readonly string[]
	readonly copyMode?: boolean
}

export interface AgentInstallResult {
	readonly path: string
	readonly method: 'symlink' | 'copy'
}

export interface InstallResult {
	readonly canonicalPath: string
	readonly agentInstalls: Record<string, AgentInstallResult>
}

export interface UninstallSkillOptions {
	readonly slug: string
	readonly scope: 'local' | 'global'
	readonly agentSlug?: string
}

/**
 * Resolve the canonical storage path for a skill.
 * Local: .skills/<slug>/   Global: ~/.purrfectclaw/skills/<slug>/
 */
function canonicalDir(scope: 'local' | 'global', slug: string): string {
	if (scope === 'global') {
		return join(home, '.purrfectclaw', 'skills', slug)
	}
	return join(process.cwd(), '.skills', slug)
}

/**
 * Extract a ZIP buffer to a target directory.
 * Validates all paths to prevent zip-slip / path traversal attacks.
 */
export function extractZip(buffer: Buffer, targetDir: string): void {
	const entries = unzipSync(new Uint8Array(buffer))
	const resolvedTarget = normalize(targetDir)

	mkdirSync(resolvedTarget, { recursive: true })

	for (const [name, data] of Object.entries(entries)) {
		// Reject absolute paths and path traversal
		if (posix.isAbsolute(name) || name.startsWith('/') || name.startsWith('\\')) {
			throw new Error(`Zip entry has absolute path: ${name}`)
		}
		if (name.includes('..')) {
			throw new Error(`Zip entry contains path traversal: ${name}`)
		}

		const dest = join(resolvedTarget, name)
		const rel = relative(resolvedTarget, dest)
		if (rel.startsWith('..') || normalize(dest) === resolvedTarget) {
			throw new Error(`Zip entry escapes target directory: ${name}`)
		}

		// Directory entries end with /
		if (name.endsWith('/')) {
			mkdirSync(dest, { recursive: true })
		} else {
			mkdirSync(join(dest, '..'), { recursive: true })
			writeFileSync(dest, data)
		}
	}
}

/**
 * Verify that a buffer's SHA256 matches the expected hash.
 */
function verifySha256(buffer: Buffer, expected: string): void {
	const actual = createHash('sha256').update(buffer).digest('hex')
	if (actual !== expected) {
		throw new Error(
			`SHA256 mismatch: expected ${expected}, got ${actual}. The download may be corrupted.`,
		)
	}
}

/**
 * Resolve the agent skill directory path for the given scope.
 */
function agentSkillDir(agent: AgentDefinition, scope: 'local' | 'global', slug: string): string {
	if (scope === 'global') {
		return agent.globalSkillPath(slug)
	}
	return agent.localSkillPath(process.cwd(), slug)
}

/**
 * Recursively copy a directory's contents to a destination.
 */
function copyDirRecursive(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true })
	for (const entry of readdirSync(src)) {
		const srcPath = join(src, entry)
		const destPath = join(dest, entry)
		if (statSync(srcPath).isDirectory()) {
			copyDirRecursive(srcPath, destPath)
		} else {
			copyFileSync(srcPath, destPath)
		}
	}
}

/**
 * Install a skill: verify hash, extract to canonical path, then symlink or copy to each agent directory.
 */
export function installSkill(options: InstallSkillOptions): InstallResult {
	const { slug, buffer, sha256, scope, agents, copyMode } = options

	verifySha256(buffer, sha256)

	const canonical = canonicalDir(scope, slug)
	mkdirSync(canonical, { recursive: true })
	extractZip(buffer, canonical)

	const agentInstalls: Record<string, AgentInstallResult> = {}
	const installedAgentDirs: string[] = []

	try {
		for (const agentSlug of agents) {
			const agent = getAgent(agentSlug)
			if (!agent) {
				throw new Error(`Unknown agent: "${agentSlug}"`)
			}

			const targetDir = agentSkillDir(agent, scope, slug)

			if (copyMode) {
				copyDirRecursive(canonical, targetDir)
				agentInstalls[agentSlug] = { path: targetDir, method: 'copy' }
			} else {
				// Symlink mode with auto-fallback to copy
				mkdirSync(join(targetDir, '..'), { recursive: true })
				// Remove existing target if present (stale symlink or old copy)
				if (existsSync(targetDir)) {
					rmSync(targetDir, { recursive: true, force: true })
				}
				try {
					symlinkSync(canonical, targetDir, 'dir')
					agentInstalls[agentSlug] = { path: targetDir, method: 'symlink' }
				} catch {
					// Fallback to copy if symlink fails (e.g. on Windows without dev mode)
					copyDirRecursive(canonical, targetDir)
					agentInstalls[agentSlug] = { path: targetDir, method: 'copy' }
				}
			}

			installedAgentDirs.push(targetDir)
		}
	} catch (err) {
		// Rollback: clean up agent dirs and canonical on failure
		for (const dir of installedAgentDirs) {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true })
			}
		}
		if (existsSync(canonical)) {
			rmSync(canonical, { recursive: true, force: true })
		}
		throw err
	}

	return { canonicalPath: canonical, agentInstalls }
}

/**
 * Uninstall a skill: remove symlinks/copies from agent directories and clean up canonical if no agents remain.
 *
 * If agentSlug is provided, only that agent's install is removed.
 * Otherwise all agent installs from the lock entry should be cleaned up by the caller
 * (this function removes the canonical directory).
 */
export function uninstallSkill(options: UninstallSkillOptions): void {
	const { slug, scope, agentSlug } = options
	const canonical = canonicalDir(scope, slug)

	if (agentSlug) {
		// Remove from a single agent
		const agent = getAgent(agentSlug)
		if (!agent) {
			throw new Error(`Unknown agent: "${agentSlug}"`)
		}
		const targetDir = agentSkillDir(agent, scope, slug)
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true })
		}
	} else {
		// Remove canonical directory (caller is removing all agents)
		if (existsSync(canonical)) {
			rmSync(canonical, { recursive: true, force: true })
		}
	}
}
