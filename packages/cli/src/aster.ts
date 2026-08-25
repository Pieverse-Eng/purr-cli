export function resolveAsterUser(
  args: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const user = args.user ?? env.ASTER_USER_WALLET
  if (!user) {
    throw new Error('Missing required argument: --user or ASTER_USER_WALLET')
  }
  return user
}
