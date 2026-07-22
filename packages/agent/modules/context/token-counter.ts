/**
 * TokenCounter — 字符近似 token 估算
 *
 * 不引入 tiktoken 等外部依赖，采用字符近似策略：
 *  - ASCII 可打印字符（0x20-0x7E）：约 4 字符/token
 *  - 非 ASCII 字符（中文、CJK、emoji 等）：约 1.5 字符/token
 * 中英混合文本按字符类型加权累加。
 *
 * `TokenCounter` 类支持 `calibrate` 方法，用 provider 返回的真实 input_tokens
 * 按指数滑动平均（α=0.5）回填校正因子，使后续估算逐步趋近真实值。
 */

/** ASCII 可打印字符 token 估算系数：约 4 字符/token */
const ASCII_CHARS_PER_TOKEN = 4;
/** 非 ASCII 字符 token 估算系数：约 1.5 字符/token */
const NON_ASCII_CHARS_PER_TOKEN = 1.5;

/** 指数滑动平均学习率 α=0.5 */
const EMA_ALPHA = 0.5;

/**
 * 字符近似估算文本的 token 数（无状态纯函数）。
 *
 * 按字符类型加权累加：
 *   tokens = asciiCount / 4 + nonAsciiCount / 1.5
 *
 * 使用 `for...of` 迭代以正确处理 Unicode 代理对（如 emoji）。
 * 空字符串返回 0。
 *
 * @param text 待估算文本
 * @returns 估算 token 数（浮点数，调用方可按需向上取整）
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code <= 0x7e) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }

  return asciiCount / ASCII_CHARS_PER_TOKEN + nonAsciiCount / NON_ASCII_CHARS_PER_TOKEN;
}

/**
 * Token 估算器，带可校准的校正因子。
 *
 * 构造时 `factor = 1.0`，`estimate(text)` 返回 `estimateTokens(text) * factor`。
 * 当 provider 返回真实 input_tokens 后，调用 `calibrate(realInputTokens, estimatedTokens)`
 * 用指数滑动平均（α=0.5）更新 factor，使后续估算逐步趋近真实值。
 */
export class TokenCounter {
  /** 当前校正因子，初始 1.0 */
  private factor: number = 1.0;

  /**
   * 返回当前估算值（已应用校正因子）。
   *
   * @param text 待估算文本
   * @returns 估算 token 数 = estimateTokens(text) * factor
   */
  estimate(text: string): number {
    return estimateTokens(text) * this.factor;
  }

  /**
   * 用 provider 返回的真实 input_tokens 校正 factor（指数滑动平均，α=0.5）。
   *
   * 更新公式：
   *   factor = α * (realInputTokens / estimatedTokens) + (1-α) * factor
   * 其中 α=0.5。
   *
   * 当 `estimatedTokens` 为 0 时跳过更新，避免除零。
   *
   * @param realInputTokens provider 返回的真实 input_tokens
   * @param estimatedTokens 对应文本的本地估算值（由 `estimate` 或 `estimateTokens` 返回）
   */
  calibrate(realInputTokens: number, estimatedTokens: number): void {
    if (estimatedTokens === 0) return;
    const ratio = realInputTokens / estimatedTokens;
    this.factor = EMA_ALPHA * ratio + (1 - EMA_ALPHA) * this.factor;
  }

  /**
   * 返回当前校正因子。
   *
   * 主要供测试与调试观察收敛行为使用。
   */
  getFactor(): number {
    return this.factor;
  }
}
