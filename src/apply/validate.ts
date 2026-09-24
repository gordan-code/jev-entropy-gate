import { applyToContent, type Rewrite } from "../apply.ts";

/**
 * 校验一批改写仍然对应给定的原文，并在校验通过后生成新内容。
 *
 * 非空改写使用半开区间 [offset, offset + before.length)；零宽插入
 * 不允许出现在非空改写的内部或边界，也不允许同一偏移存在多次插入。
 */
export function validateRewrites(content: string, rewrites: Rewrite[]): string {
  const ranges: Array<{ index: number; start: number; end: number }> = [];

  for (let index = 0; index < rewrites.length; index++) {
    const rewrite = rewrites[index]!;
    const { offset } = rewrite;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) {
      throw new Error(`改写 #${index} 的偏移 offset 越界或不是安全整数。`);
    }

    const end = offset + rewrite.before.length;
    if (end > content.length) {
      throw new Error(`改写 #${index} 的范围超出内容长度。`);
    }
    if (content.slice(offset, end) !== rewrite.before) {
      throw new Error(`改写 #${index} 的原文 before 与当前内容不符。`);
    }

    ranges.push({ index, start: offset, end });
  }

  // 任意冲突区间在按起点排序后，都会出现在相邻项之间；只需线性扫描。
  const sorted = [...ranges].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.index - b.index
  );
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1]!;
    const right = sorted[i]!;
    const leftZeroWidth = left.start === left.end;
    const rightZeroWidth = right.start === right.end;

    if (leftZeroWidth && rightZeroWidth) {
      if (left.start === right.start) {
        throw new Error(`改写 #${left.index} 和 #${right.index} 在同一偏移重复插入。`);
      }
      continue;
    }

    if (leftZeroWidth || rightZeroWidth) {
      const insertion = leftZeroWidth ? left.start : right.start;
      const nonEmpty = leftZeroWidth ? right : left;
      if (insertion >= nonEmpty.start && insertion <= nonEmpty.end) {
        throw new Error(
          `改写 #${leftZeroWidth ? left.index : right.index} 的插入位置与改写 #${
            leftZeroWidth ? right.index : left.index
          } 的范围冲突。`
        );
      }
      continue;
    }

    if (left.start < right.end && right.start < left.end) {
      throw new Error(`改写 #${left.index} 和 #${right.index} 的范围重叠。`);
    }
  }

  return applyToContent(content, rewrites);
}
