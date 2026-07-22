import { describe, it, expect } from 'bun:test';
import { PromptComposer } from '../prompt/prompt-composer.ts';
import type { ChatMessage } from '../ui-pattern.ts';

describe('PromptComposer', () => {
  const stableSystem = '# 角色稳定指令\n身份与行为规范...';

  function userMsg(text: string): ChatMessage {
    return { role: 'user', content: text };
  }
  function assistantMsg(text: string): ChatMessage {
    return { role: 'assistant', content: text };
  }
  function envInfoMsg(): ChatMessage {
    return { role: 'system', kind: 'env_info', content: '# 环境信息\n- cwd: /tmp' };
  }
  function modeReminderMsg(content: string): ChatMessage {
    return { role: 'system', kind: 'mode_reminder', content };
  }

  it('should place stable system first', () => {
    const pc = new PromptComposer(stableSystem);
    const out = pc.compose([userMsg('hi')]);
    expect(out[0]).toEqual({ role: 'system', content: stableSystem });
  });

  it('should place env_info after stable system and before conversation history', () => {
    const pc = new PromptComposer(stableSystem);
    const out = pc.compose([userMsg('hi')], { envInfo: envInfoMsg() });
    expect(out[0]?.role).toBe('system');
    expect(out[0]?.content).toBe(stableSystem);
    expect(out[1]).toEqual(envInfoMsg());
    expect(out[2]).toEqual(userMsg('hi'));
  });

  it('should place mode_reminder at the end when provided', () => {
    const pc = new PromptComposer(stableSystem);
    const reminder = modeReminderMsg('[模式提醒]');
    const out = pc.compose([userMsg('hi'), assistantMsg('hello')], {
      modeReminder: reminder,
    });
    expect(out[out.length - 1]).toEqual(reminder);
  });

  it('should output full order: stable → env_info → history → mode_reminder', () => {
    const pc = new PromptComposer(stableSystem);
    const reminder = modeReminderMsg('[模式提醒]');
    const out = pc.compose(
      [userMsg('q1'), assistantMsg('a1'), userMsg('q2')],
      { envInfo: envInfoMsg(), modeReminder: reminder },
    );
    expect(out).toEqual([
      { role: 'system', content: stableSystem },
      envInfoMsg(),
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      reminder,
    ]);
  });

  it('should filter out old stable system (system msg without kind) from history', () => {
    const pc = new PromptComposer(stableSystem);
    const oldSystem: ChatMessage = { role: 'system', content: '旧的角色 prompt' };
    const out = pc.compose([oldSystem, userMsg('hi')]);
    // 旧 system 被过滤，只剩新的稳定 system + user
    expect(out).toEqual([
      { role: 'system', content: stableSystem },
      userMsg('hi'),
    ]);
  });

  it('should keep system msg with kind (env_info/mode_reminder/system_supplement) from history', () => {
    const pc = new PromptComposer(stableSystem);
    const supplement: ChatMessage = {
      role: 'system',
      kind: 'system_supplement',
      content: '外部工具上线提醒',
    };
    const out = pc.compose([supplement, userMsg('hi')]);
    // 带 kind 的 system 消息保留在原位（不被当作旧稳定 system 过滤）
    expect(out).toEqual([
      { role: 'system', content: stableSystem },
      supplement,
      userMsg('hi'),
    ]);
  });

  it('should not inject env_info when undefined', () => {
    const pc = new PromptComposer(stableSystem);
    const out = pc.compose([userMsg('hi')]);
    expect(out.find((m) => m.kind === 'env_info')).toBeUndefined();
  });

  it('should not inject mode_reminder when null or undefined', () => {
    const pc = new PromptComposer(stableSystem);
    const out1 = pc.compose([userMsg('hi')], { modeReminder: null });
    const out2 = pc.compose([userMsg('hi')], { modeReminder: undefined });
    expect(out1.find((m) => m.kind === 'mode_reminder')).toBeUndefined();
    expect(out2.find((m) => m.kind === 'mode_reminder')).toBeUndefined();
  });

  it('should produce only stable system when messages empty and no opts', () => {
    const pc = new PromptComposer(stableSystem);
    const out = pc.compose([]);
    expect(out).toEqual([{ role: 'system', content: stableSystem }]);
  });

  it('should preserve tool/assistant messages in history', () => {
    const pc = new PromptComposer(stableSystem);
    const toolMsg: ChatMessage = {
      role: 'tool',
      content: 'result',
      tool_call_id: 'call_1',
    };
    const assistantWithTools: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'grep', arguments: '{}' }],
    };
    const out = pc.compose([userMsg('hi'), assistantWithTools, toolMsg]);
    expect(out).toEqual([
      { role: 'system', content: stableSystem },
      userMsg('hi'),
      assistantWithTools,
      toolMsg,
    ]);
  });

  it('should accept rhythm metadata (round/modeChanged/firstRound) without affecting assembly', () => {
    const pc = new PromptComposer(stableSystem);
    const out = pc.compose([userMsg('hi')], {
      round: 5,
      modeChanged: true,
      firstRound: false,
      modeReminder: modeReminderMsg('[reminder]'),
    });
    // 元数据不影响拼装顺序，仅 modeReminder 被追加
    expect(out).toEqual([
      { role: 'system', content: stableSystem },
      userMsg('hi'),
      modeReminderMsg('[reminder]'),
    ]);
  });

  it('should expose stable system via getStableSystem()', () => {
    const pc = new PromptComposer(stableSystem);
    expect(pc.getStableSystem()).toBe(stableSystem);
  });
});
