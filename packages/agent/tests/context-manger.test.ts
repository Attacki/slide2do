import { describe, it, expect } from 'bun:test';
import { ContextManager } from '../modules/context/context-manger.ts';

describe('ContextManager', () => {
  it('should collect basic env info (cwd/platform/arch)', async () => {
    const cm = new ContextManager();
    const info = await cm.getEnvInfo();
    expect(info.cwd).toBe(process.cwd());
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.custom).toEqual({});
  });

  it('should produce a kind:env_info message with rendered content', async () => {
    const cm = new ContextManager();
    const msg = await cm.toMessage();
    expect(msg.role).toBe('system');
    expect(msg.kind).toBe('env_info');
    expect(msg.content).toContain('工作目录');
    expect(msg.content).toContain('操作系统');
    expect(msg.content).not.toContain('当前时间');
    expect(msg.content).not.toContain('时区');
    expect(msg.content).toContain(process.cwd());
    expect(msg.content).toContain(process.platform);
  });

  it('should register and collect custom field via sync provider', async () => {
    const cm = new ContextManager();
    cm.registerField('nodeVersion', () => process.version);
    const info = await cm.getEnvInfo();
    expect(info.custom.nodeVersion).toBe(process.version);
    const msg = await cm.toMessage();
    expect(msg.content).toContain(`nodeVersion: ${process.version}`);
  });

  it('should register and collect custom field via async provider', async () => {
    const cm = new ContextManager();
    cm.registerField('asyncField', async () => {
      return 'async-value';
    });
    const info = await cm.getEnvInfo();
    expect(info.custom.asyncField).toBe('async-value');
  });

  it('should not block other fields when one provider throws', async () => {
    const cm = new ContextManager();
    cm.registerField('bad', () => {
      throw new Error('boom');
    });
    cm.registerField('good', () => 'ok');
    const info = await cm.getEnvInfo();
    expect(info.custom.bad).toBeUndefined();
    expect(info.custom.good).toBe('ok');
  });

  it('should not block other fields when one async provider rejects', async () => {
    const cm = new ContextManager();
    cm.registerField('badAsync', async () => {
      throw new Error('async boom');
    });
    cm.registerField('goodAsync', async () => 'ok');
    const info = await cm.getEnvInfo();
    expect(info.custom.badAsync).toBeUndefined();
    expect(info.custom.goodAsync).toBe('ok');
  });

  it('should overwrite when registering same name twice', async () => {
    const cm = new ContextManager();
    cm.registerField('dup', () => 'first');
    cm.registerField('dup', () => 'second');
    const info = await cm.getEnvInfo();
    expect(info.custom.dup).toBe('second');
  });

  it('should run custom providers in registration order', async () => {
    const order: string[] = [];
    const cm = new ContextManager();
    cm.registerField('a', () => {
      order.push('a');
      return 'a';
    });
    cm.registerField('b', () => {
      order.push('b');
      return 'b';
    });
    cm.registerField('c', async () => {
      order.push('c');
      return 'c';
    });
    await cm.getEnvInfo();
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
