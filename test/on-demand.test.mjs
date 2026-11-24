/**
 * 按需门控的离线测试（1.2.0）。
 *
 * 覆盖九件事：
 *  1. `onDemand` 默认开 → 六个工具注册都带 `when`；
 *  2. 模型用 `skill` 工具加载 `ssh-remote` 后，该 agent 的工具变为可用；
 *  3. 加载**别的** skill 不放行；失败的 skill 调用也不放行；
 *  4. 用户 `/ssh-remote` 斜杠调用（`session/event` 的 `skill-invocation`）同样放行；
 *  5. resume / fork 兜底：请求头里已声明过本插件工具 → 放行；
 *  6. 请求头读取抛错（会话已 dispose）按"未激活"处理，不向上抛；
 *  7. fail-open：该模式看不到 `skill` 工具时不做门控（保持常驻）；
 *  8. `onDemand: false` 时注册不带 `when`（1.1.x 的老行为）；
 *  9. `Config` 的 schemastery 默认值，以及 skill 定义本身注册进了 skills 服务。
 *
 * 绝不 SSH：`apply()` 只接线，连接是懒建立；这里只挂载、只读注册结果。
 * `DSH_HOME` 指向临时目录，保证测试不碰真实的 `~/.dsh`。
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-ssh-on-demand-test');

const { apply, Config, readOption } = await import('../index.js');
const { SKILL_NAME } = await import('../lib/skill.mjs');

/** 本插件的六个工具名（顺序与 `buildTools()` 的返回一致）。 */
const EXPECTED_TOOLS = ['ssh_host', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_fetch', 'ssh_job'];

/**
 * 造一个够 `apply()` 用的 mock ctx。
 *
 * @param {{
 *   onDemand?: boolean,
 *   skillVisible?: boolean,
 *   services?: string[],
 * }} [options]
 *   `skillVisible: false` 模拟 minimal 这类看不到 `skill` 工具的模式（fail-open）；
 *   `services` 是"这个 profile 里存在的服务"，`ctx.inject` 只在这些都齐时才回调
 *   （Cordis 语义：缺依赖就永远不注入，而不是注入一个残缺 ctx）。
 * @returns {{
 *   registrations: { tool: any, options: any }[],
 *   skills: any[],
 *   emit: (event: string, ...args: any[]) => void,
 *   agents: Map<string, any>,
 *   when: ((context: { agent?: any }) => boolean) | undefined,
 * }} the harness.
 */
function mount(options = {}) {
  const registrations = [];
  const handlers = new Map();
  const skills = [];
  const agents = new Map();
  const skillVisible = options.skillVisible !== false;
  const available = new Set(options.services ?? ['skills', 'settings']);

  /** 宿主机上的服务（`ctx.get` 按名返回）。 */
  const base = {
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    tools: {
      register(tool, registrationOptions = {}) {
        const entry = { tool, options: registrationOptions };
        registrations.push(entry);
        return () => {
          const index = registrations.indexOf(entry);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
      get(name) {
        if (name !== 'skill') return undefined;
        return skillVisible ? { name: 'skill' } : undefined;
      },
    },
    effect(callback, label) {
      const cleanup = callback();
      void label;
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    },
    inject(names, callback) {
      if (!names.every((name) => available.has(name))) return;
      const scoped = {
        ...base,
        skills: {
          register(definition) {
            skills.push(definition);
            return () => undefined;
          },
        },
        settings: { configure: () => () => undefined },
      };
      callback(scoped);
    },
  };

  apply(base, options.config);

  return {
    registrations,
    skills,
    agents,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    when: registrations[0]?.options.when,
  };
}

/** 一个够用的假 agent（`requestHeader()` 可配）。 */
function createAgent(headerTools = [], options = {}) {
  return {
    session: {
      id: options.id ?? 'session-test',
      requestHeader: options.throwOnHeader
        ? () => {
          throw new Error('session disposed');
        }
        : () => ({ tools: headerTools }),
    },
  };
}

test('1.2.0：默认 onDemand 开，六个工具都带 when', () => {
  const { registrations } = mount();
  assert.equal(registrations.length, 6, '应注册 6 个工具');
  assert.deepEqual(
    registrations.map((entry) => entry.tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
    '应恰好是六个 ssh_* 工具',
  );
  for (const entry of registrations) {
    assert.equal(typeof entry.options.when, 'function', `${entry.tool.name} 应带 when`);
  }
});

test('1.2.0：未加载 skill 时工具不可见；加载后该 agent 放行', () => {
  const { when } = mount();
  const agent = createAgent();
  assert.equal(when({ agent }), false, '刚开的会话不该看见工具');

  const harness = mount();
  harness.emit('tools/result', { name: 'skill', agent, arguments: { name: SKILL_NAME } }, { isError: false });
  assert.equal(harness.when({ agent }), true, '加载 skill 后应放行');
});

test('1.2.0：别的 skill 不放行；失败的 skill 调用不放行', () => {
  const { when, emit } = mount();

  const other = createAgent();
  emit('tools/result', { name: 'skill', agent: other, arguments: { name: 'some-other-skill' } }, { isError: false });
  assert.equal(when({ agent: other }), false, '别的 skill 不该放行');

  const failed = createAgent();
  emit('tools/result', { name: 'skill', agent: failed, arguments: { name: SKILL_NAME } }, { isError: true });
  assert.equal(when({ agent: failed }), false, '失败的 skill 调用不该放行');
});

test('1.2.0：用户 /ssh-remote 斜杠调用也放行（session/event 路径）', () => {
  const { when, emit, agents } = mount();
  const session = { id: 'session-slash' };
  const agent = { ...createAgent([], { id: session.id }), session };
  agents.set(session.id, agent);

  emit('session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: SKILL_NAME } },
  });
  assert.equal(when({ agent }), true, '斜杠调用后应放行');
});

test('1.2.0：resume/fork 兜底 —— 请求头里已声明本插件工具则放行', () => {
  const { when } = mount();
  const resumed = createAgent([{ name: 'ssh_job', description: '', parameters: {} }]);
  assert.equal(when({ agent: resumed }), true, '历史请求头已有声明时应放行');
});

test('1.2.0：请求头读取抛错按未激活处理（不让 when 抛出去）', () => {
  const { when } = mount();
  const broken = createAgent([], { throwOnHeader: true });
  assert.equal(when({ agent: broken }), false, '读不到请求头时应视为未激活');
});

test('1.2.0：agent 未定义时放行（系统视图不门控）', () => {
  const { when } = mount();
  assert.equal(when({}), true);
  assert.equal(when({ agent: undefined }), true);
});

test('1.2.0：fail-open —— 该模式没有 skill 工具时不门控', () => {
  const { when, registrations } = mount({ skillVisible: false });
  assert.equal(registrations.length, 6, '工具仍应注册');
  for (const entry of registrations) {
    assert.equal(typeof entry.options.when, 'function', 'when 仍然挂上，只是判定恒真');
  }
  assert.equal(when({ agent: createAgent() }), true, '没有 skill 工具的模式应保持常驻');
});

test('1.2.0：onDemand:false 时注册不带 when（老行为）', () => {
  const { registrations } = mount({ config: { onDemand: false } });
  assert.equal(registrations.length, 6);
  for (const entry of registrations) {
    assert.equal(entry.options.when, undefined, `${entry.tool.name} 不该带 when`);
  }
});

test('1.2.0：Config 的 schemastery 默认值 —— onDemand 默认 true，显式 false 才关', () => {
  assert.equal(Config({}).onDemand, true, 'onDemand 不是 volatile，解析后是普通布尔');
  assert.equal(Config({ onDemand: false }).onDemand, false);
  assert.equal(Config({ onDemand: true }).onDemand, true);
  // 其它字段仍然是 volatile（解析成 live ref），经 readOption 才拿到值——这次只加了一个开关。
  assert.equal(readOption(Config({}), 'maxOutputBytes', 0), 65536);
  assert.equal(readOption(Config({}), 'connectTimeoutMs', 0), 15000);
  assert.equal(readOption(Config({}), 'onDemand', false), true);
});

test('1.2.0：skills 服务已注册 ssh-remote 说明书，正文声明了“按需、下一步出现”', () => {
  const { skills } = mount();
  assert.equal(skills.length, 1, '应注册一份 skill');
  const definition = skills[0];
  assert.equal(definition.name, 'ssh-remote');
  assert.equal(definition.source, 'runtime');
  assert.equal(definition.invocation.modelInvocable, true, '模型要能用 skill 工具加载它');
  assert.equal(definition.invocation.userInvocable, true, '用户要能 /ssh-remote 调用');
  assert.match(definition.whenToUse, /只读本地文件/, 'whenToUse 要写清什么情况下不要用');
  assert.match(definition.content, /工具是按需的，加载本技能后从下一步出现/);
  assert.match(definition.content, /ssh_host/);
  assert.match(definition.content, /local-relay/);
  assert.match(definition.content, /remote-direct/);
  assert.ok(definition.content.length < 8192, `正文 ${definition.content.length} 字符，超过 8192 会被工具结果修剪器截断`);
});

test('1.2.0：没有 skills 服务时 apply 不崩，工具照常注册', () => {
  const { registrations, skills } = mount({ services: [] });
  assert.equal(registrations.length, 6, '没有 skills 服务也要注册工具');
  assert.equal(skills.length, 0, '没有 skills 服务就跳过 skill 注册');
  for (const entry of registrations) {
    assert.equal(typeof entry.options.when, 'function');
  }
});
