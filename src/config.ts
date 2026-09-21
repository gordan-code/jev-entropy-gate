export function getJevApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.JEV_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "JEV_API_KEY is not set. Export it before running, or copy .env.example to .env."
    );
  }
  return key;
}