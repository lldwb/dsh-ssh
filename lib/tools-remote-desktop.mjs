/**
 * dsh-ssh — the two remote desktop tools.
 *
 * ## Why two, and why an `action` argument
 *
 * The agent under the hood has 18 commands, all with different arguments. Exposing
 * 18 tools would put a large schema on every request and still leave the model
 * guessing which one to combine. Two tools split by **effect** instead:
 *
 * | tool | effect | actions |
 * |---|---|---|
 * | `ssh_desktop_screen` | read-only eyes | `info`, `screenshot`, `windows`, `ui_dump` |
 * | `ssh_desktop_action` | anything that changes the remote desktop | `focus`, `move`, `click`, `drag`, `scroll`, `down`, `up`, `key`, `text`, `sequence`, `ui_invoke`, `ui_set_value` |
 *
 * Both are on-demand: they appear only after the `ssh-remote-desktop` skill is
 * loaded, and only while `dsh-desktop-control` (the prerequisite that owns the
 * agent script) is enabled. The schema stays off unrelated requests entirely.
 *
 * ## The discipline every return value follows
 *
 * A third-party plugin cannot import the registry's `defineTool`, so the strict
 * subset is written by hand. The registry validates what `execute` returns
 * against `output.schema`: an undeclared field, or a `null` where a `number` was
 * declared, fails the call with `tool returned invalid output` **after the
 * remote work already happened**. Therefore:
 *
 * - every returned field is declared in the schema;
 * - a failure returns only the common declared fields, with `ok:false` and an
 *   actionable `code`/`message`;
 * - `null` is never returned for a declared field; absent data is simply omitted,
 *   and numbers fall back to `0`.
 *
 * ## Latency is part of the contract
 *
 * Each call is a scheduled-task round trip (~2–5 s measured over SSH), plus the
 * agent's PowerShell startup. The descriptions and the skill both say: **batch
 * with `sequence`** instead of issuing click → type → key as three calls.
 *
 * @module dsh-ssh/lib/tools-remote-desktop
 */

import { RemoteDesktopError } from './remote-desktop.mjs';

/** One text content block, the shape every `render` returns. */
function text(content) {
  return [{ type: 'text', text: content }];
}

/** One property node of the supported strict JSON-Schema subset. */
function prop(type, description, extra = {}) {
  return { type, ...(description === undefined ? {} : { description }), ...extra };
}

/** One strict object node. */
function obj(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) };
}

/** One array node. */
function arr(items, description) {
  return { type: 'array', ...(description === undefined ? {} : { description }), items };
}

/** A string enum node. */
function enumProp(values, description) {
  return { type: 'string', enum: values, ...(description === undefined ? {} : { description }) };
}

/** Turn a thrown value into a message. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The machine-readable code of a failure. */
function errorCode(error) {
  return error instanceof RemoteDesktopError ? error.code : 'REMOTE_DESKTOP_FAILED';
}

/** A short diagnostic appendix (kept out of the main verdict line). */
function errorDetail(error) {
  return error instanceof RemoteDesktopError && error.detail !== '' ? error.detail : '';
}

/** Escape a value for a markdown table cell. */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** Human-readable byte count. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

// ───────────────────────────── shared schema nodes ────────────────────────────

const CURSOR_SCHEMA = obj({ x: prop('number', 'x（物理像素）'), y: prop('number', 'y（物理像素）') }, ['x', 'y']);

const RECT_SCHEMA = obj(
  { x: prop('number'), y: prop('number'), width: prop('number'), height: prop('number') },
  ['x', 'y', 'width', 'height'],
);

const FOREGROUND_SCHEMA = obj(
  {
    hwnd: prop('number', '窗口句柄。'),
    title: prop('string', '窗口标题（可能为空）。'),
    className: prop('string', '窗口类名。'),
    pid: prop('number', '进程 id。'),
    processName: prop('string', '进程名（不含 .exe）。'),
  },
  ['hwnd', 'title', 'className', 'pid', 'processName'],
);

const MONITOR_SCHEMA = obj(
  {
    index: prop('number'),
    name: prop('string'),
    primary: prop('boolean'),
    x: prop('number'),
    y: prop('number'),
    width: prop('number'),
    height: prop('number'),
    workX: prop('number'),
    workY: prop('number'),
    workWidth: prop('number'),
    workHeight: prop('number'),
    dpi: prop('number'),
    scale: prop('number'),
  },
  ['index', 'name', 'primary', 'x', 'y', 'width', 'height', 'workX', 'workY', 'workWidth', 'workHeight', 'dpi', 'scale'],
);

const INFO_SCHEMA = obj(
  {
    screen: obj({ width: prop('number'), height: prop('number') }, ['width', 'height']),
    virtualScreen: RECT_SCHEMA,
    monitors: arr(MONITOR_SCHEMA, '每块显示器的物理矩形、工作区与 DPI。'),
    monitorCount: prop('number'),
    cursor: CURSOR_SCHEMA,
    dpi: prop('number', '主屏 DPI（96 = 100%）。'),
    scale: prop('number', '主屏缩放比。'),
    dpiAware: prop('string', '代理进程的 DPI 感知模式。'),
    foreground: FOREGROUND_SCHEMA,
  },
  ['screen', 'virtualScreen', 'monitors', 'monitorCount', 'cursor', 'dpi', 'scale', 'dpiAware', 'foreground'],
);

const WINDOW_SCHEMA = obj(
  {
    hwnd: prop('number'),
    title: prop('string'),
    className: prop('string'),
    pid: prop('number'),
    processName: prop('string'),
    x: prop('number'),
    y: prop('number'),
    width: prop('number'),
    height: prop('number'),
    visible: prop('boolean'),
    minimized: prop('boolean'),
    maximized: prop('boolean'),
    foreground: prop('boolean'),
  },
  ['hwnd', 'title', 'className', 'pid', 'processName', 'x', 'y', 'width', 'height', 'visible', 'minimized', 'maximized', 'foreground'],
);

const SHOT_SCHEMA = obj(
  {
    path: prop('string', '本机 PNG 绝对路径。用 read_image 打开它。'),
    remotePath: prop('string', '远端临时路径（回传后已删除）。'),
    width: prop('number', '输出图宽度。'),
    height: prop('number', '输出图高度。'),
    sourceWidth: prop('number', '截取区域的物理像素宽度。'),
    sourceHeight: prop('number', '截取区域的物理像素高度。'),
    scale: prop('number', '物理像素 / 输出图像素。scale=1 时图内像素就是物理像素。'),
    frame: RECT_SCHEMA,
    region: RECT_SCHEMA,
    bytes: prop('number', '本机 PNG 字节数。'),
    captureMethod: prop('string', '实际生效的截图档位。'),
    captureLevel: prop('number', '这一档对远端用户的影响等级（0 最轻）。'),
    blank: prop('boolean', '抓到的图是否为全同色空白（锁屏/最小化时的典型结果）。'),
    minimized: prop('boolean'),
    occluded: prop('boolean'),
    activated: prop('boolean'),
    restored: prop('boolean'),
    cursor: CURSOR_SCHEMA,
    foreground: FOREGROUND_SCHEMA,
    maxWidth: prop('number', '请求的输出最大宽度（0 = 未缩放）。'),
  },
  ['path', 'remotePath', 'width', 'height', 'sourceWidth', 'sourceHeight', 'scale', 'frame', 'region', 'bytes', 'captureMethod', 'captureLevel', 'blank', 'minimized', 'occluded', 'activated', 'restored', 'cursor', 'foreground', 'maxWidth'],
);

const UI_ELEMENT_SCHEMA = obj(
  {
    index: prop('number', '在 dump 结果里的序号。'),
    name: prop('string'),
    automationId: prop('string'),
    controlType: prop('string'),
    className: prop('string'),
    x: prop('number'),
    y: prop('number'),
    width: prop('number'),
    height: prop('number'),
    enabled: prop('boolean'),
    offscreen: prop('boolean'),
    patterns: arr(prop('string'), '支持的 UIA pattern（patterns:true 时才有）。'),
  },
  ['index', 'name', 'automationId', 'controlType', 'className', 'x', 'y', 'width', 'height', 'enabled', 'offscreen', 'patterns'],
);

const UI_SCHEMA = obj(
  {
    hwnd: prop('number'),
    title: prop('string'),
    count: prop('number', '返回的元素数量。'),
    totalElements: prop('number', '窗口里 UIA 暴露的元素总数。'),
    shellOnly: prop('boolean', '是否只有外壳（应用可能没有暴露完整 UIA 树）。'),
    elements: arr(UI_ELEMENT_SCHEMA, '扁平化的元素列表（受 maxNodes 限制）。'),
    foreground: FOREGROUND_SCHEMA,
  },
  ['hwnd', 'title', 'count', 'totalElements', 'shellOnly', 'elements', 'foreground'],
);

const ATTEMPT_SCHEMA = obj(
  { method: prop('string'), ok: prop('boolean'), reason: prop('string') },
  ['method', 'ok', 'reason'],
);

const CLICK_SCHEMA = obj(
  {
    planned: prop('string', '最终采用的点击档位：uia / message / flash / real。'),
    attempts: arr(ATTEMPT_SCHEMA, '阶梯上每一档的结论。'),
    point: CURSOR_SCHEMA,
    windowHwnd: prop('number', '该点实际落在的顶层窗口。'),
    windowTitle: prop('string'),
    coveredByHwnd: prop('number', '遮挡窗口（与目标窗口不同时才有意义）。'),
    coveredByTitle: prop('string'),
  },
  ['planned', 'attempts', 'point', 'windowHwnd', 'windowTitle', 'coveredByHwnd', 'coveredByTitle'],
);

const DRAG_SCHEMA = obj(
  {
    fromX: prop('number'),
    fromY: prop('number'),
    toX: prop('number'),
    toY: prop('number'),
    button: prop('string'),
    restoredCursor: prop('boolean'),
  },
  ['fromX', 'fromY', 'toX', 'toY', 'button', 'restoredCursor'],
);

const SCROLL_SCHEMA = obj(
  { clicks: prop('number'), horizontal: prop('boolean'), restoredCursor: prop('boolean') },
  ['clicks', 'horizontal', 'restoredCursor'],
);

const FOCUS_SCHEMA = obj(
  {
    hwnd: prop('number'),
    title: prop('string'),
    focused: prop('boolean'),
    method: prop('string', '拿到前台的档位：already / setforeground / altkey / topmost / minimized。'),
    state: prop('string'),
    attempts: arr(ATTEMPT_SCHEMA, '每一档的结论。'),
  },
  ['hwnd', 'title', 'focused', 'method', 'state', 'attempts'],
);

const SEQUENCE_STEP_SCHEMA = obj(
  {
    index: prop('number'),
    action: prop('string'),
    ok: prop('boolean'),
    skipped: prop('boolean'),
    reason: prop('string'),
  },
  ['index', 'action', 'ok', 'skipped', 'reason'],
);

const SEQUENCE_SCHEMA = obj(
  {
    hwnd: prop('number'),
    title: prop('string'),
    focused: prop('boolean'),
    focusMethod: prop('string'),
    state: prop('string'),
    stepCount: prop('number'),
    failedSteps: prop('number'),
    aborted: prop('string', '中途放弃的原因，空串表示全部执行完。'),
    steps: arr(SEQUENCE_STEP_SCHEMA),
  },
  ['hwnd', 'title', 'focused', 'focusMethod', 'state', 'stepCount', 'failedSteps', 'aborted', 'steps'],
);

const UI_ACTION_SCHEMA = obj(
  {
    hwnd: prop('number'),
    title: prop('string'),
    action: prop('string'),
    applied: prop('boolean'),
    matched: prop('number', '匹配到的元素数量。'),
    index: prop('number', '实际使用的匹配序号。'),
    value: prop('string', '写入的值（ui_set_value）。'),
    element: UI_ELEMENT_SCHEMA,
  },
  ['hwnd', 'title', 'action', 'applied', 'matched', 'index', 'value', 'element'],
);

/** Common fields every return value carries. */
const COMMON_PROPERTIES = {
  ok: prop('boolean', '是否成功。'),
  code: prop('string', '结果码：成功是 OK，失败是可读的机器码（如 NOT_WINDOWS / PREREQUISITE_DISABLED）。'),
  message: prop('string', '人类可读摘要；失败时是要怎么修。'),
  host: prop('string', 'SSH 服务器名字。'),
  target: prop('string', '"user@host:port"。'),
  action: prop('string', '实际执行的 action。'),
  durationMs: prop('number', '本次调用耗时。'),
};

/** The common required field list. */
const COMMON_REQUIRED = ['ok', 'code', 'message', 'host', 'target', 'action', 'durationMs'];

// ───────────────────────────── normalizers ───────────────────────────────────

/** Normalize one agent window object into the declared shape. */
function normalizeWindow(entry) {
  return {
    hwnd: Number(entry?.hwnd) || 0,
    title: String(entry?.title ?? ''),
    className: String(entry?.className ?? ''),
    pid: Number(entry?.pid) || 0,
    processName: String(entry?.processName ?? ''),
    x: Number(entry?.x) || 0,
    y: Number(entry?.y) || 0,
    width: Number(entry?.width) || 0,
    height: Number(entry?.height) || 0,
    visible: entry?.visible === true,
    minimized: entry?.minimized === true,
    maximized: entry?.maximized === true,
    foreground: entry?.foreground === true,
  };
}

/** Normalize one cursor object. */
function normalizeCursor(value) {
  return { x: Number(value?.x) || 0, y: Number(value?.y) || 0 };
}

/** Normalize one foreground object. */
function normalizeForeground(value) {
  return {
    hwnd: Number(value?.hwnd) || 0,
    title: String(value?.title ?? ''),
    className: String(value?.className ?? ''),
    pid: Number(value?.pid) || 0,
    processName: String(value?.processName ?? ''),
  };
}

/** Normalize the agent's `info` payload. */
function normalizeInfo(info) {
  const virtualScreen = info?.virtualScreen ?? {};
  // The agent serialises `monitors` as an array for two or more displays and as a
  // single object for one (measured on a real host: `"monitors":{"index":0,…}`).
  const rawMonitors = info?.monitors;
  const monitors = Array.isArray(rawMonitors)
    ? rawMonitors
    : rawMonitors !== null && typeof rawMonitors === 'object'
      ? [rawMonitors]
      : [];
  return {
    screen: { width: Number(info?.screen?.width) || 0, height: Number(info?.screen?.height) || 0 },
    virtualScreen: {
      x: Number(virtualScreen.x) || 0,
      y: Number(virtualScreen.y) || 0,
      width: Number(virtualScreen.width) || 0,
      height: Number(virtualScreen.height) || 0,
    },
    monitors: monitors.map((entry, index) => ({
      index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index,
      name: String(entry?.name ?? ''),
      primary: entry?.primary === true,
      x: Number(entry?.x) || 0,
      y: Number(entry?.y) || 0,
      width: Number(entry?.width) || 0,
      height: Number(entry?.height) || 0,
      workX: Number(entry?.workX) || 0,
      workY: Number(entry?.workY) || 0,
      workWidth: Number(entry?.workWidth) || 0,
      workHeight: Number(entry?.workHeight) || 0,
      dpi: Number(entry?.dpi) || 96,
      scale: Number(entry?.scale) || 1,
    })),
    monitorCount: monitors.length,
    cursor: normalizeCursor(info?.cursor),
    dpi: Number(info?.dpi) || 96,
    scale: Number(info?.scale) || 1,
    dpiAware: String(info?.dpiAware ?? ''),
    foreground: normalizeForeground(info?.foreground),
  };
}

/** Normalize the agent's `screenshot` payload plus the local file. */
function normalizeShot(shot, maxWidth) {
  const frame = shot?.frame ?? {};
  return {
    path: String(shot?.localPath ?? ''),
    remotePath: String(shot?.remotePath ?? ''),
    width: Number(shot?.width) || 0,
    height: Number(shot?.height) || 0,
    sourceWidth: Number(shot?.sourceWidth) || 0,
    sourceHeight: Number(shot?.sourceHeight) || 0,
    scale: Number(shot?.scale) || 1,
    frame: {
      x: Number(frame.x) || 0,
      y: Number(frame.y) || 0,
      width: Number(frame.width) || 0,
      height: Number(frame.height) || 0,
    },
    region: {
      x: Number(frame.x) || 0,
      y: Number(frame.y) || 0,
      width: Number(frame.width) || 0,
      height: Number(frame.height) || 0,
    },
    bytes: Number(shot?.bytes) || 0,
    captureMethod: String(shot?.captureMethod ?? 'screen'),
    captureLevel: Number(shot?.captureLevel) || 0,
    blank: shot?.blank === true,
    minimized: shot?.minimized === true,
    occluded: shot?.occluded === true,
    activated: shot?.activated === true,
    restored: shot?.restored === true,
    cursor: normalizeCursor(shot?.cursor),
    foreground: normalizeForeground(shot?.foreground),
    maxWidth: Number.isFinite(maxWidth) ? Number(maxWidth) : 0,
  };
}

/** Normalize one UIA element into the declared shape. */
function normalizeUiElement(entry, index) {
  return {
    index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index,
    name: String(entry?.name ?? ''),
    automationId: String(entry?.automationId ?? ''),
    controlType: String(entry?.controlType ?? ''),
    className: String(entry?.className ?? ''),
    x: Number(entry?.x) || 0,
    y: Number(entry?.y) || 0,
    width: Number(entry?.width) || 0,
    height: Number(entry?.height) || 0,
    enabled: entry?.enabled !== false,
    offscreen: entry?.offscreen === true,
    patterns: Array.isArray(entry?.patterns) ? entry.patterns.filter((pattern) => typeof pattern === 'string') : [],
  };
}

/** Normalize the agent's `ui_dump` payload. */
function normalizeUi(ui) {
  const nodes = Array.isArray(ui?.nodes) ? ui.nodes : [];
  return {
    hwnd: Number(ui?.hwnd) || 0,
    title: String(ui?.title ?? ''),
    count: Number(ui?.count) || nodes.length,
    totalElements: Number(ui?.totalElements) || nodes.length,
    shellOnly: ui?.shellOnly === true,
    elements: nodes.map((entry, index) => normalizeUiElement(entry, index)),
    foreground: normalizeForeground(ui?.foreground),
  };
}

/** Normalize the agent's click payload. */
function normalizeClick(click) {
  const window = click?.window ?? {};
  const coveredBy = click?.coveredBy ?? {};
  const attempts = Array.isArray(click?.attempts) ? click.attempts : [];
  return {
    planned: String(click?.planned ?? ''),
    attempts: attempts.map((entry) => ({
      method: String(entry?.method ?? ''),
      ok: entry?.ok === true,
      reason: String(entry?.reason ?? ''),
    })),
    point: normalizeCursor(click?.point),
    windowHwnd: Number(window.rootHwnd ?? window.hwnd) || 0,
    windowTitle: String(window.title ?? ''),
    coveredByHwnd: Number(coveredBy.hwnd) || 0,
    coveredByTitle: String(coveredBy.title ?? ''),
  };
}

/** Render the info summary. */
function renderInfo(value) {
  const info = value.info;
  const lines = [
    `## ${value.host} 远端桌面（${value.target}）`,
    '',
    `- 屏幕（物理像素）：${info.screen.width}x${info.screen.height}，虚拟桌面 ${info.virtualScreen.width}x${info.virtualScreen.height} @(${info.virtualScreen.x},${info.virtualScreen.y})`,
    `- DPI：${info.dpi}（缩放 ${Math.round(info.scale * 100)}%），代理 DPI 感知：${info.dpiAware === '' ? '未知' : info.dpiAware}`,
    `- 光标：(${info.cursor.x}, ${info.cursor.y})`,
    `- 前台窗口：hwnd=${info.foreground.hwnd} pid=${info.foreground.pid} 进程=${info.foreground.processName || '?'}「${info.foreground.title}」`,
    `- 显示器：${info.monitorCount} 块`,
  ];
  for (const monitor of info.monitors) {
    lines.push(`  - monitor:${monitor.index}${monitor.primary ? '（主屏）' : ''} ${monitor.name} ${monitor.width}x${monitor.height} @(${monitor.x},${monitor.y}) DPI ${monitor.dpi}/x${monitor.scale}，工作区 ${monitor.workWidth}x${monitor.workHeight} @(${monitor.workX},${monitor.workY})`);
  }
  lines.push('', '所有坐标都是**物理像素**；点击前用 `ssh_desktop_screen action="windows"` 找目标窗口。');
  return text(lines.join('\n'));
}

/** Render the screenshot summary. */
function renderShot(value) {
  const shot = value.shot;
  const lines = [
    `## 远端截图（${value.host}）`,
    '',
    `- 本机路径：\`${shot.path}\`（用 read_image 打开）`,
    `- 图像 ${shot.width}x${shot.height}，取自物理像素 (${shot.frame.x}, ${shot.frame.y}) ${shot.frame.width}x${shot.frame.height}，scale=${shot.scale}`,
    `- 方式：${shot.captureMethod}（影响等级 ${shot.captureLevel}），大小 ${humanBytes(shot.bytes)}`,
  ];
  if (shot.blank) lines.push('- ⚠ 这张图是空白（全同色）：远端可能锁屏/息屏，或窗口最小化。');
  if (shot.maxWidth === 0) {
    lines.push('- 未缩放：图内像素 = 物理像素。点击坐标 = frame 原点 + 图上坐标。');
  } else {
    lines.push(`- 已缩放到最大宽 ${shot.maxWidth}：点击坐标 = frame 原点 + 图上坐标 × ${shot.scale}。需要精确点击时传 maxWidth: 0 重截一次。`);
  }
  return text(lines.join('\n'));
}

/** Render the windows summary. */
function renderWindows(value) {
  const lines = [`## ${value.host} 上的窗口（${value.windows.length} 个）`, ''];
  if (value.windows.length === 0) {
    lines.push('没有匹配的窗口。');
    return text(lines.join('\n'));
  }
  lines.push('| hwnd | 标题 | 进程 | 位置/大小 | 状态 |', '| --- | --- | --- | --- | --- |');
  for (const window of value.windows) {
    const state = [window.foreground ? '前台' : '', window.minimized ? '最小化' : '', window.maximized ? '最大化' : ''].filter((part) => part !== '').join(' ');
    lines.push(`| ${window.hwnd} | ${cell(window.title)} | ${cell(window.processName)} | (${window.x},${window.y}) ${window.width}x${window.height} | ${state === '' ? '—' : state} |`);
  }
  lines.push('', '用 `ssh_desktop_action action="focus" hwnd=<hwnd>` 激活窗口；截图可用 `ssh_desktop_screen action="screenshot" hwnd=<hwnd>`。');
  return text(lines.join('\n'));
}

/** Render the ui_dump summary. */
function renderUi(value) {
  const ui = value.ui;
  const lines = [
    `## ${value.host} · UI 树「${ui.title}」（hwnd=${ui.hwnd}）`,
    '',
    `元素 ${ui.count}/${ui.totalElements}${ui.shellOnly ? '（只有外壳，应用可能没暴露完整 UIA 树）' : ''}`,
    '',
    '| # | 类型 | 名称 | automationId | 位置/大小 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const element of ui.elements.slice(0, 80)) {
    lines.push(`| ${element.index} | ${cell(element.controlType)} | ${cell(element.name)} | ${cell(element.automationId)} | (${element.x},${element.y}) ${element.width}x${element.height} |`);
  }
  if (ui.elements.length > 80) lines.push('', `（只显示前 80 个；用 maxNodes / uiFilter 缩小范围。）`);
  lines.push('', '用 `ssh_desktop_action action="ui_invoke" hwnd=<hwnd> name="<名称>"` 直接触发控件（不动鼠标、不抢焦点）。');
  return text(lines.join('\n'));
}

/** Render one action result summary. */
function renderAction(value) {
  const lines = [`## ${value.action} · ${value.host}（${value.target}）`, ''];
  if (value.focus !== undefined) {
    lines.push(`- 窗口「${value.focus.title}」：${value.focus.focused ? '已到前台' : '未能到前台'}（方式 ${value.focus.method || '—'}）`);
  }
  if (value.click !== undefined) {
    lines.push(`- 点击 (${value.click.point.x}, ${value.click.point.y})：档位 ${value.click.planned}，命中窗口「${value.click.windowTitle}」`);
    if (value.click.coveredByTitle !== '' && value.click.coveredByHwnd !== value.click.windowHwnd) {
      lines.push(`- ⚠ 该点实际被「${value.click.coveredByTitle}」遮挡`);
    }
  }
  if (value.drag !== undefined) {
    lines.push(`- 拖拽 (${value.drag.fromX}, ${value.drag.fromY}) → (${value.drag.toX}, ${value.drag.toY}) · ${value.drag.button}`);
  }
  if (value.scroll !== undefined) {
    lines.push(`- 滚轮 ${value.scroll.clicks} 格${value.scroll.horizontal ? '（横向）' : ''}`);
  }
  if (value.keys !== undefined) lines.push(`- 按键：${value.keys.join(' + ')}`);
  if (value.characters !== undefined) lines.push(`- 已输入 ${value.characters} 个字符`);
  if (value.sequence !== undefined) {
    lines.push(`- 序列 ${value.sequence.stepCount} 步，失败 ${value.sequence.failedSteps} 步${value.sequence.aborted === '' ? '' : `，中止：${value.sequence.aborted}`}`);
    for (const step of value.sequence.steps) {
      lines.push(`  - #${step.index} ${step.action} ${step.ok ? '✓' : '✗'} ${step.skipped ? '（跳过）' : ''} ${step.reason}`);
    }
  }
  if (value.ui !== undefined) {
    lines.push(`- UIA ${value.ui.action}${value.ui.applied ? ' 已执行' : ' 未生效'}：匹配 ${value.ui.matched} 个，使用第 ${value.ui.index} 个${value.ui.element.name === '' ? '' : `「${value.ui.element.name}」`}`);
  }
  if (value.cursor !== undefined) lines.push('', `光标现在 (${value.cursor.x}, ${value.cursor.y})`);
  if (value.foreground !== undefined) lines.push(`前台窗口：「${value.foreground.title}」(${value.foreground.processName})`);
  lines.push('', '下一步：用 `ssh_desktop_screen action="screenshot"` 截图确认结果。');
  return text(lines.join('\n'));
}

/**
 * Build both tool definitions.
 *
 * @param {{
 *   service: Record<string, any>,
 *   remote: ReturnType<import('./remote-desktop.mjs').createRemoteDesktop>,
 *   options: () => { timeoutMs: number, screenshotMaxWidth: number, indicator: boolean },
 * }} env - the component environment.
 * @returns {any[]} the tool definitions.
 */
export function buildRemoteDesktopTools(env) {
  const { service, remote, options } = env;

  /** Resolve the profile and the common host/target fields. */
  function profileOf(args) {
    const profile = service.resolveProfileFromArgs(args);
    return {
      profile,
      host: String(profile.name),
      target: `${profile.user}@${profile.host}:${profile.port}`,
    };
  }

  /** Read one optional window reference from args (`hwnd` or a title substring). */
  function windowRef(args) {
    const ref = {};
    if (Number.isFinite(Number(args.hwnd)) && Number(args.hwnd) > 0) ref.hwnd = Number(args.hwnd);
    if (typeof args.window === 'string' && args.window.trim() !== '') ref.title = args.window.trim();
    return ref;
  }

  /** A failure value with only the common declared fields. */
  function failure(action, host, target, error, started) {
    const detail = errorDetail(error);
    const message = detail === ''
      ? `❌ ${errorText(error)}`
      : `❌ ${errorText(error)}\n\n诊断：\n${detail}`;
    return {
      ok: false,
      code: errorCode(error),
      message,
      host,
      target,
      action,
      durationMs: Date.now() - started,
    };
  }

  /** The per-call timeout from the argument or the plugin config. */
  function timeoutOf(args) {
    return typeof args.timeoutSec === 'number' && args.timeoutSec > 0
      ? Math.round(args.timeoutSec * 1000)
      : options().timeoutMs;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_desktop_screen
  // ───────────────────────────────────────────────────────────────────────────
  const screenTool = {
    name: 'ssh_desktop_screen',
    description:
      '在**已经通过 SSH 保存的 Windows 服务器**上观察它的桌面：屏幕几何/DPI/光标/前台窗口（info）、'
      + '截图并取回本机（screenshot，返回本机 PNG 路径给 read_image）、列出窗口（windows）、dump 窗口的 UI Automation 树（ui_dump）。'
      + '这是远程桌面操作的「眼睛」：动手（ssh_desktop_action）之前先 info/windows 建立坐标与目标，动手之后截图确认结果。'
      + '坐标一律是远端屏幕的**物理像素**（DPI-aware），不是逻辑分辨率；截图返回 frame 与 scale，用来把图里的位置换算成点击坐标。'
      + '前提：dsh-desktop-control 已启用（它提供桌面代理脚本），且远端 Windows 有该账号的交互式登录会话；否则工具不可用或调用报错。'
      + '注意每次调用是「SSH → 交互式计划任务 → 代理启动」的一次往返，约 2–5 秒；把多次观察合并成一次（例如截图前先 windows 拿 hwnd）能少花时间。',
    parameters: obj({
      action: enumProp(['info', 'screenshot', 'windows', 'ui_dump'], '要做什么。默认 info。'),
      host: prop('string', '已保存的 SSH 服务器名。省略时用 defaultHost 或唯一一台服务器。'),
      timeoutSec: prop('number', '本次调用的超时秒数（默认取插件配置，60 秒）。'),
      window: prop('string', '按窗口标题子串指定目标窗口（screenshot / ui_dump）。与 hwnd 二选一，hwnd 优先。'),
      hwnd: prop('number', '按窗口句柄指定目标窗口（screenshot / ui_dump）。'),
      maxWidth: prop('number', '截图输出最大宽度（默认取插件配置 1600；0 = 不缩放，图内像素即物理像素）。'),
      capture: enumProp(['auto', 'printwindow', 'bitblt', 'screen'], '截图从哪一档开始（仍会逐级降级）。默认 auto。'),
      allowActivate: prop('boolean', '允许截图时还原并切前台（会打扰远端用户），默认 false。'),
      filter: prop('string', 'windows：只返回标题包含该子串的窗口。'),
      includeInvisible: prop('boolean', 'windows：是否包含不可见窗口，默认 false。'),
      limit: prop('number', 'windows：最多返回多少个窗口，默认 120。'),
      uiFilter: prop('string', 'ui_dump：只返回名称包含该子串的元素。'),
      maxNodes: prop('number', 'ui_dump：最多返回多少个元素，默认 200。'),
    }, []),
    output: {
      schema: obj(
        {
          ...COMMON_PROPERTIES,
          info: INFO_SCHEMA,
          shot: SHOT_SCHEMA,
          windows: arr(WINDOW_SCHEMA, '窗口列表（前台优先，其余按面积从大到小）。'),
          foreground: FOREGROUND_SCHEMA,
          ui: UI_SCHEMA,
        },
        COMMON_REQUIRED,
      ),
      render: (args, value) => {
        if (value.ok !== true) return text(value.message);
        if (value.action === 'info') return renderInfo(value);
        if (value.action === 'screenshot') return renderShot(value);
        if (value.action === 'windows') return renderWindows(value);
        if (value.action === 'ui_dump') return renderUi(value);
        return text(value.message);
      },
    },
    async execute(args) {
      const started = Date.now();
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'info';
      let host = '';
      let target = '';
      try {
        const resolved = profileOf(input);
        host = resolved.host;
        target = resolved.target;
        const timeoutMs = timeoutOf(input);

        if (action === 'info') {
          const { data } = await remote.call(resolved.profile, 'info', {}, { timeoutMs });
          const info = normalizeInfo(data);
          return { ok: true, code: 'OK', message: `✅ ${host} 远端桌面 ${info.screen.width}x${info.screen.height}`, host, target, action, durationMs: Date.now() - started, info };
        }

        if (action === 'windows') {
          const { data } = await remote.call(resolved.profile, 'windows', {
            ...(typeof input.filter === 'string' && input.filter !== '' ? { filter: input.filter } : {}),
            ...(input.includeInvisible === true ? { includeInvisible: true } : {}),
            ...(Number.isFinite(Number(input.limit)) ? { limit: Math.round(Number(input.limit)) } : {}),
          }, { timeoutMs });
          const windows = Array.isArray(data.windows) ? data.windows.map(normalizeWindow) : [];
          return { ok: true, code: 'OK', message: `✅ ${host} 上 ${windows.length} 个窗口`, host, target, action, durationMs: Date.now() - started, windows, foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'screenshot') {
          let hwnd = Number.isFinite(Number(input.hwnd)) && Number(input.hwnd) > 0 ? Number(input.hwnd) : 0;
          const windowTitle = typeof input.window === 'string' ? input.window.trim() : '';
          if (hwnd <= 0 && windowTitle !== '') {
            // The agent resolves titles for focus/UIA, but its screenshot command
            // only takes a hwnd. Resolve it with one windows call so the caller
            // does not have to do a separate round trip.
            const { data } = await remote.call(resolved.profile, 'windows', { filter: windowTitle, limit: 50 }, { timeoutMs });
            const candidates = Array.isArray(data.windows) ? data.windows : [];
            const chosen = candidates.find((entry) => entry?.foreground === true) ?? candidates[0];
            if (chosen === undefined) {
              throw new RemoteDesktopError('WINDOW_NOT_FOUND', `找不到标题包含「${windowTitle}」的窗口。下一步：先 action="windows" 看现有窗口标题。`);
            }
            hwnd = Number(chosen.hwnd) || 0;
          }
          const maxWidth = Number.isFinite(Number(input.maxWidth)) ? Math.max(0, Math.round(Number(input.maxWidth))) : options().screenshotMaxWidth;
          const shotData = await remote.screenshot(resolved.profile, {
            ...(hwnd > 0 ? { hwnd } : {}),
            ...(typeof input.capture === 'string' ? { capture: input.capture } : {}),
            ...(input.allowActivate === true ? { allowActivate: true } : {}),
            maxWidth,
          }, { timeoutMs });
          const shot = normalizeShot(shotData, maxWidth);
          return { ok: true, code: 'OK', message: `✅ 已截图并取回：${shot.path}`, host, target, action, durationMs: Date.now() - started, shot };
        }

        if (action === 'ui_dump') {
          const ref = windowRef(input);
          if (ref.hwnd === undefined && ref.title === undefined) {
            throw new RemoteDesktopError('BAD_ARGUMENT', 'ui_dump 需要 hwnd 或 window（标题子串）指定窗口。先用 action="windows" 找。');
          }
          const { data } = await remote.call(resolved.profile, 'ui_dump', {
            ...ref,
            ...(typeof input.uiFilter === 'string' && input.uiFilter !== '' ? { filter: input.uiFilter } : {}),
            ...(Number.isFinite(Number(input.maxNodes)) ? { maxNodes: Math.round(Number(input.maxNodes)) } : {}),
          }, { timeoutMs });
          const ui = normalizeUi(data);
          return { ok: true, code: 'OK', message: `✅ 窗口「${ui.title}」有 ${ui.count} 个 UIA 元素`, host, target, action, durationMs: Date.now() - started, ui };
        }

        throw new RemoteDesktopError('BAD_ARGUMENT', `未知 action：${String(action)}（可用：info / screenshot / windows / ui_dump）`);
      } catch (error) {
        return failure(action, host, target, error, started);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `远程桌面：${String(args.action ?? 'info')}${typeof args.host === 'string' ? ` @${args.host}` : ''}`,
      kind: 'read',
    }),
  };

  // ───────────────────────────────────────────────────────────────────────────
  // ssh_desktop_action
  // ───────────────────────────────────────────────────────────────────────────
  const actionTool = {
    name: 'ssh_desktop_action',
    description:
      '在**已经通过 SSH 保存的 Windows 服务器**上操作它的真实桌面：移动/点击/拖拽/滚轮鼠标、按键与输入文本、聚焦窗口、'
      + '按序列一次完成「聚焦 + 连续动作」（sequence）、以及 UI Automation 的 invoke/set_value（不动鼠标、不抢焦点）。'
      + '前提：dsh-desktop-control 已启用、远端 Windows 有该账号的交互式登录会话；坐标是远端屏幕的**物理像素**（和 ssh_desktop_screen 截图同一坐标系）。'
      + '每次调用是一次 SSH → 交互式计划任务 → 代理启动的往返（约 2–5 秒），所以**多步操作优先用 sequence**：'
      + '把 focus + click + text + key + wait 放进一个 steps 数组，而不是连续调多次工具。'
      + '这是操作真实用户的桌面：不要关未保存的窗口、不要向不认识的窗口输入敏感信息；每次动作后建议截图确认。'
      + '如果目标窗口在远端被最小化/被挡住，先用 sequence 的 state/restore 或 focus；截图别用 allowActivate。',
    parameters: obj({
      action: enumProp(
        ['focus', 'move', 'click', 'drag', 'scroll', 'down', 'up', 'key', 'text', 'sequence', 'ui_invoke', 'ui_set_value'],
        '要做什么。默认 click。',
      ),
      host: prop('string', '已保存的 SSH 服务器名。省略时用 defaultHost 或唯一一台服务器。'),
      timeoutSec: prop('number', '本次调用的超时秒数（默认取插件配置，60 秒）。sequence 里含 wait 时放够。'),
      x: prop('number', '目标 x（物理像素）。move/click/scroll 用；click 不传则点当前光标位置。'),
      y: prop('number', '目标 y（物理像素）。'),
      fromX: prop('number', 'drag 起点 x。'),
      fromY: prop('number', 'drag 起点 y。'),
      toX: prop('number', 'drag 终点 x。'),
      toY: prop('number', 'drag 终点 y。'),
      button: enumProp(['left', 'right', 'middle'], '鼠标键，默认 left。'),
      clicks: prop('number', '点击次数 1–3（2 = 双击）；scroll 时是滚轮格数（正=上，负=下）。'),
      durationMs: prop('number', '移动/拖拽耗时（毫秒）；move 默认 0 = 瞬移，drag 默认 400。'),
      settleMs: prop('number', 'move 后原地停留毫秒（悬停类 UI 用 300–700）。'),
      restoreCursor: prop('boolean', '动作后把光标放回原处（click 默认 flash 档会做；drag/scroll 可显式要求）。'),
      key: prop('string', '单个键名，如 Enter / ArrowDown / F5 / a。'),
      combo: prop('string', '组合键，如 Ctrl+C / Alt+Tab（与 key 二选一，都给了优先 combo）。'),
      times: prop('number', '按键重复次数，1–50，默认 1。'),
      text: prop('string', '要输入的文本（\\n 按 Enter、\\t 按 Tab；最长 4000 字符）。'),
      window: prop('string', '按标题子串指定目标窗口（focus / sequence / ui_invoke / ui_set_value）。hwnd 优先。'),
      hwnd: prop('number', '按窗口句柄指定目标窗口。'),
      state: prop('string', '窗口状态：restore / maximize / minimize（focus / sequence 用）；none 表示不动。'),
      steps: arr(
        obj({
          action: enumProp(['click', 'key', 'text', 'wait'], '这一步做什么。'),
          x: prop('number'),
          y: prop('number'),
          button: enumProp(['left', 'right', 'middle']),
          clicks: prop('number'),
          key: prop('string'),
          combo: prop('string'),
          text: prop('string'),
          ms: prop('number', 'wait 的毫秒数（默认 300）。'),
          settleMs: prop('number', '这一步之后的停顿毫秒。'),
          continueOnError: prop('boolean', '这一步失败后是否继续，默认 false（整体中止）。'),
        }, ['action']),
        'sequence 的步骤：按顺序执行 focus（默认）+ 每一步。',
      ),
      uiAction: enumProp(['default', 'invoke', 'toggle', 'select', 'expand', 'collapse', 'focus', 'value'], 'ui_invoke 的动作，默认 default（依次尝试 invoke/toggle/select）。'),
      name: prop('string', 'UIA：元素名称（Name）。'),
      automationId: prop('string', 'UIA：元素 AutomationId。'),
      controlType: prop('string', 'UIA：控件类型，如 Button / Edit。'),
      value: prop('string', 'ui_set_value 要写入的文本，或 ui_invoke action="value" 的值。'),
      index: prop('number', 'UIA：匹配到多个时用第几个（从 0 开始），默认 0。'),
      maxCount: prop('number', 'UIA：最多匹配多少个，默认 10。'),
    }, ['action']),
    output: {
      schema: obj(
        {
          ...COMMON_PROPERTIES,
          cursor: CURSOR_SCHEMA,
          foreground: FOREGROUND_SCHEMA,
          point: CURSOR_SCHEMA,
          click: CLICK_SCHEMA,
          drag: DRAG_SCHEMA,
          scroll: SCROLL_SCHEMA,
          keys: arr(prop('string'), '按键序列（每个元素是一个按键描述）。'),
          characters: prop('number', '已输入的字符数。'),
          focus: FOCUS_SCHEMA,
          sequence: SEQUENCE_SCHEMA,
          ui: UI_ACTION_SCHEMA,
        },
        COMMON_REQUIRED,
      ),
      render: (_args, value) => (value.ok === true ? renderAction(value) : text(value.message)),
    },
    async execute(args) {
      const started = Date.now();
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'click';
      let host = '';
      let target = '';
      try {
        const resolved = profileOf(input);
        host = resolved.host;
        target = resolved.target;
        const timeoutMs = timeoutOf(input);
        const common = { ok: true, code: 'OK', host, target, action };

        if (action === 'focus') {
          const ref = windowRef(input);
          if (ref.hwnd === undefined && ref.title === undefined) {
            throw new RemoteDesktopError('BAD_ARGUMENT', 'focus 需要 hwnd 或 window（标题子串）。先用 ssh_desktop_screen action="windows" 找。');
          }
          const { data } = await remote.call(resolved.profile, 'focus', {
            ...ref,
            ...(typeof input.state === 'string' && input.state !== '' ? { state: input.state } : {}),
          }, { timeoutMs });
          const focus = {
            hwnd: Number(data.hwnd) || ref.hwnd || 0,
            title: String(data.title ?? ''),
            focused: data.focused === true,
            method: String(data.method ?? ''),
            state: String(data.state ?? ''),
            attempts: (Array.isArray(data.attempts) ? data.attempts : []).map((entry) => ({ method: String(entry?.method ?? ''), ok: entry?.ok === true, reason: String(entry?.reason ?? '') })),
          };
          return { ...common, message: `✅ focus「${focus.title}」→ ${focus.focused ? '前台' : '未到前台'}（${focus.method || '—'}）`, durationMs: Date.now() - started, focus };
        }

        if (action === 'move') {
          const { data } = await remote.call(resolved.profile, 'move', {
            ...(Number.isFinite(Number(input.x)) ? { x: Math.round(Number(input.x)) } : {}),
            ...(Number.isFinite(Number(input.y)) ? { y: Math.round(Number(input.y)) } : {}),
            ...(Number.isFinite(Number(input.durationMs)) ? { durationMs: Math.round(Number(input.durationMs)) } : {}),
            ...(Number.isFinite(Number(input.settleMs)) ? { settleMs: Math.round(Number(input.settleMs)) } : {}),
          }, { timeoutMs });
          const cursor = normalizeCursor(data.cursor);
          return { ...common, message: `✅ 光标 → (${cursor.x}, ${cursor.y})`, durationMs: Date.now() - started, cursor, foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'click') {
          const hasPoint = Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y));
          const { data } = await remote.call(resolved.profile, 'click', {
            ...(hasPoint ? { x: Math.round(Number(input.x)), y: Math.round(Number(input.y)) } : {}),
            ...(typeof input.button === 'string' ? { button: input.button } : {}),
            ...(Number.isFinite(Number(input.clicks)) ? { clicks: Math.round(Number(input.clicks)) } : {}),
            ...(typeof input.restoreCursor === 'boolean' ? { restoreCursor: input.restoreCursor } : {}),
          }, { timeoutMs });
          const click = normalizeClick(data);
          return { ...common, message: `✅ 点击 (${click.point.x}, ${click.point.y}) · ${click.planned} · 命中「${click.windowTitle}」`, durationMs: Date.now() - started, click, cursor: normalizeCursor(data.cursor), foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'drag') {
          const { data } = await remote.call(resolved.profile, 'drag', {
            fromX: Math.round(Number(input.fromX) || 0),
            fromY: Math.round(Number(input.fromY) || 0),
            toX: Math.round(Number(input.toX) || 0),
            toY: Math.round(Number(input.toY) || 0),
            ...(typeof input.button === 'string' ? { button: input.button } : {}),
            ...(Number.isFinite(Number(input.durationMs)) ? { durationMs: Math.round(Number(input.durationMs)) } : {}),
            ...(input.restoreCursor === true ? { restoreCursor: true } : {}),
          }, { timeoutMs });
          const drag = {
            fromX: Math.round(Number(input.fromX) || 0),
            fromY: Math.round(Number(input.fromY) || 0),
            toX: Math.round(Number(input.toX) || 0),
            toY: Math.round(Number(input.toY) || 0),
            button: typeof input.button === 'string' ? input.button : 'left',
            restoredCursor: data.restoredCursor === true,
          };
          return { ...common, message: `✅ 拖拽完成（${drag.button}）`, durationMs: Date.now() - started, drag, cursor: normalizeCursor(data.cursor), foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'scroll') {
          const { data } = await remote.call(resolved.profile, 'scroll', {
            ...(Number.isFinite(Number(input.clicks)) ? { clicks: Math.round(Number(input.clicks)) } : {}),
            ...(Number.isFinite(Number(input.x)) ? { x: Math.round(Number(input.x)) } : {}),
            ...(Number.isFinite(Number(input.y)) ? { y: Math.round(Number(input.y)) } : {}),
            ...(input.restoreCursor === true ? { restoreCursor: true } : {}),
          }, { timeoutMs });
          const scroll = {
            clicks: Number(data.clicks) || 0,
            horizontal: data.horizontal === true,
            restoredCursor: data.restoredCursor === true,
          };
          return { ...common, message: `✅ 滚轮 ${scroll.clicks} 格`, durationMs: Date.now() - started, scroll, cursor: normalizeCursor(data.cursor), foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'down' || action === 'up') {
          const { data } = await remote.call(resolved.profile, action, {
            ...(typeof input.button === 'string' ? { button: input.button } : {}),
          }, { timeoutMs });
          return { ...common, message: `✅ ${action} 完成`, durationMs: Date.now() - started, cursor: normalizeCursor(data.cursor) };
        }

        if (action === 'key') {
          const { data } = await remote.call(resolved.profile, 'key', {
            ...(typeof input.key === 'string' ? { key: input.key } : {}),
            ...(typeof input.combo === 'string' ? { combo: input.combo } : {}),
            ...(Number.isFinite(Number(input.times)) ? { times: Math.round(Number(input.times)) } : {}),
          }, { timeoutMs });
          const keys = Array.isArray(data.keySequence) ? data.keySequence.filter((entry) => typeof entry === 'string') : [];
          return { ...common, message: `✅ 已按键 ${keys.join(' + ')}`, durationMs: Date.now() - started, keys, foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'text') {
          if (typeof input.text !== 'string' || input.text === '') {
            throw new RemoteDesktopError('BAD_ARGUMENT', 'text 为空：要输入什么？');
          }
          const { data } = await remote.call(resolved.profile, 'text', { text: input.text }, { timeoutMs });
          const characters = Number(data.characters) || 0;
          return { ...common, message: `✅ 已输入 ${characters} 个字符`, durationMs: Date.now() - started, characters, foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'sequence') {
          const steps = Array.isArray(input.steps) ? input.steps : [];
          if (steps.length === 0) {
            throw new RemoteDesktopError('BAD_ARGUMENT', 'sequence 需要 steps 数组（至少一步）。');
          }
          const ref = windowRef(input);
          const { data } = await remote.call(resolved.profile, 'sequence', {
            ...ref,
            ...(typeof input.state === 'string' && input.state !== '' ? { state: input.state } : {}),
            ...(input.restoreCursor === true ? { restoreCursor: true } : {}),
            steps,
          }, { timeoutMs });
          const sequence = {
            hwnd: Number(data.hwnd) || ref.hwnd || 0,
            title: String(data.title ?? ''),
            focused: data.focused === true,
            focusMethod: String(data.focusMethod ?? ''),
            state: String(data.state ?? ''),
            stepCount: Number(data.stepCount) || 0,
            failedSteps: Number(data.failedSteps) || 0,
            aborted: String(data.aborted ?? ''),
            steps: (Array.isArray(data.steps) ? data.steps : []).map((entry) => ({
              index: Number(entry?.index) || 0,
              action: String(entry?.action ?? ''),
              ok: entry?.ok === true,
              skipped: entry?.skipped === true,
              reason: String(entry?.reason ?? ''),
            })),
          };
          const ok = sequence.failedSteps === 0 && sequence.aborted === '';
          return { ok, code: ok ? 'OK' : 'SEQUENCE_PARTIAL', message: `${ok ? '✅' : '⚠️'} 序列 ${sequence.stepCount} 步，失败 ${sequence.failedSteps} 步${sequence.aborted === '' ? '' : `：${sequence.aborted}`}`, host, target, action, durationMs: Date.now() - started, sequence, cursor: normalizeCursor(data.cursor), foreground: normalizeForeground(data.foreground) };
        }

        if (action === 'ui_invoke' || action === 'ui_set_value') {
          const ref = windowRef(input);
          if (ref.hwnd === undefined && ref.title === undefined) {
            throw new RemoteDesktopError('BAD_ARGUMENT', `${action} 需要 hwnd 或 window 指定窗口。`);
          }
          const shared = {
            ...ref,
            ...(typeof input.name === 'string' ? { name: input.name } : {}),
            ...(typeof input.automationId === 'string' ? { automationId: input.automationId } : {}),
            ...(typeof input.controlType === 'string' ? { controlType: input.controlType } : {}),
            ...(Number.isFinite(Number(input.index)) ? { index: Math.round(Number(input.index)) } : {}),
            ...(Number.isFinite(Number(input.maxCount)) ? { maxCount: Math.round(Number(input.maxCount)) } : {}),
          };
          const command = action === 'ui_invoke' ? 'ui_invoke' : 'ui_set_value';
          if (action === 'ui_set_value' && typeof input.value !== 'string') {
            throw new RemoteDesktopError('BAD_ARGUMENT', 'ui_set_value 需要 value（要写入的文本）。');
          }
          const payload = action === 'ui_invoke'
            ? { ...shared, ...(typeof input.uiAction === 'string' ? { action: input.uiAction } : {}), ...(typeof input.value === 'string' ? { value: input.value } : {}) }
            : { ...shared, value: input.value };
          const { data } = await remote.call(resolved.profile, command, payload, { timeoutMs });
          const ui = {
            hwnd: Number(data.hwnd) || ref.hwnd || 0,
            title: String(data.title ?? ''),
            action: String(data.action ?? (action === 'ui_set_value' ? 'value' : 'default')),
            applied: data.applied === true,
            matched: Number(data.matched) || 0,
            index: Number(data.index) || 0,
            value: String(data.value ?? ''),
            element: normalizeUiElement(data.element, 0),
          };
          return { ...common, message: `${ui.applied ? '✅' : '⚠️'} ${action}「${ui.element.name || ui.title}」· 匹配 ${ui.matched} 个`, durationMs: Date.now() - started, ui, cursor: normalizeCursor(data.cursor), foreground: normalizeForeground(data.foreground) };
        }

        throw new RemoteDesktopError('BAD_ARGUMENT', `未知 action：${String(action)}（可用：focus / move / click / drag / scroll / down / up / key / text / sequence / ui_invoke / ui_set_value）`);
      } catch (error) {
        return failure(action, host, target, error, started);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `远程桌面操作：${String(args.action ?? 'click')}${typeof args.host === 'string' ? ` @${args.host}` : ''}`,
      kind: 'execute',
    }),
  };

  return [screenTool, actionTool];
}

/** Exported for tests: the tool names this component registers. */
export const REMOTE_DESKTOP_TOOL_NAMES = ['ssh_desktop_screen', 'ssh_desktop_action'];
