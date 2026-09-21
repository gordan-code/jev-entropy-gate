// 这个文件里的 fetch 都是噪声，粗过滤应把它丢掉：
// 1. 字符串字面量里的 fetch（不是真实调用点）
// 2. 注释里提到的 fetch

const doc = "调用 fetch( 之前要先登录"; // 字符串里的 fetch（应被 prefilter 剔除）

// 下面这行注释里的 fetch( 也要被剔除：
//   fetch("/api/health") 只是示例
export function health() {
  return "ok";
}

export const note = doc;