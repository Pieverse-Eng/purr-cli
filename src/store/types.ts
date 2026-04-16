export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue }

export interface SkillInfo {
  slug: string
  source: string
  qualified_slug: string
  name: string
  version: string
  category: string
  description: string
  components: string[]
  raw?: Record<string, JsonValue>
}

export interface InstallResult {
  slug: string
  qualified_slug: string
  source: string
  name: string
  version: string
  sha256?: string
  commit?: string
  skill: {
    installed: { agent: string; path: string }[]
    skipped: string[]
    errors: { agent: string; reason: string }[]
  }
}

export interface RemoveResult {
  skill: {
    removed: { agent: string; path: string }[]
    notFound: string[]
  }
  artifacts_removed?: string[]
}

export interface ListResult {
  total: number
  skills: {
    slug: string
    source: string
    qualified_slug: string
    name: string
    version: string
    category: string
    description: string
    components: string[]
  }[]
}

export interface PluginRecord {
  source: string
  version?: string
  commit?: string
  skill?: { installed?: { agent: string; path: string }[] }
  installed_at?: string
}
