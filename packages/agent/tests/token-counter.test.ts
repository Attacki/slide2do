import { describe, it, expect } from 'bun:test';
import { estimateTokens, TokenCounter } from '../modules/context/token-counter.ts';

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should estimate ~25 tokens for 100 ASCII chars (range 20-30)', () => {
    const text = 'a'.repeat(100);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(20);
    expect(tokens).toBeLessThanOrEqual(30);
  });

  it('should estimate ~67 tokens for 100 Chinese chars (range 57-77)', () => {
    const text = '中'.repeat(100);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(57);
    expect(tokens).toBeLessThanOrEqual(77);
  });

  it('should weight ASCII and non-ASCII separately in mixed text', () => {
    const text = 'a'.repeat(50) + '中'.repeat(50);
    const tokens = estimateTokens(text);
    // 加权公式: 50/4 + 50/1.5 = 12.5 + 33.333... = 45.833...
    const expected = 50 / 4 + 50 / 1.5;
    expect(tokens).toBeCloseTo(expected, 5);
  });
});

describe('TokenCounter', () => {
  it('should match estimateTokens result when factor=1.0', () => {
    const counter = new TokenCounter();
    const text = 'a'.repeat(100) + '中'.repeat(50);
    expect(counter.estimate(text)).toBe(estimateTokens(text));
    expect(counter.getFactor()).toBe(1.0);
  });

  it('should update factor to 1.5 after calibrate(200, 100) and estimate ≥ 100', () => {
    const counter = new TokenCounter();
    // 准备文本使 estimateTokens = 100（400 个 ASCII 字符）
    const text = 'a'.repeat(400);
    expect(estimateTokens(text)).toBe(100);

    // 校正: real=200, estimated=100 → factor = 0.5*2 + 0.5*1.0 = 1.5
    counter.calibrate(200, 100);
    expect(counter.getFactor()).toBeCloseTo(1.5, 5);

    // 同段文本再估算: 100 * 1.5 = 150 ≥ 100
    const after = counter.estimate(text);
    expect(after).toBeGreaterThanOrEqual(100);
    expect(after).toBeCloseTo(150, 5);
  });

  it('should not throw when calibrate called with estimatedTokens=0', () => {
    const counter = new TokenCounter();
    expect(() => counter.calibrate(0, 0)).not.toThrow();
    expect(() => counter.calibrate(100, 0)).not.toThrow();
    // factor 保持不变（跳过除零）
    expect(counter.getFactor()).toBe(1.0);
  });

  it('should converge factor toward ratio under repeated calibrate with same ratio', () => {
    const counter = new TokenCounter();
    // 连续以 real=300, estimated=100（比例 3.0）校准 30 次
    for (let i = 0; i < 30; i++) {
      counter.calibrate(300, 100);
    }
    // factor 应趋近 3.0
    expect(counter.getFactor()).toBeCloseTo(3.0, 2);
  });
});
