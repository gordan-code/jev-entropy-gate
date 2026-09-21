// 简单的 apiClient 封装 —— 靶子仓库里 fetch 应该被迁到这里。
export async function apiClient(url: string, options?: unknown) {
  return { url, options };
}

// 一个机械替换即可的 fetch 调用（应判 auto / deterministic）
export function fetchUser(id: string) {
  return fetch(`/api/users/${id}`);
}

// 一个需要理解上下文的 fetch（应判 assisted / judgment）
export function charge(amount: number) {
  const headers = { "Content-Type": "application/json" };
  if (amount <= 0) return Promise.reject(new Error("invalid amount"));
  return fetch("/api/charge", { method: "POST", headers, body: JSON.stringify({ amount }) });
}

// 一个有错误处理、机器改写有风险的 fetch（应判 manual）
export async function retryFetch(url: string, tries = 3) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}