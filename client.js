/**
 * `dsh-ssh` —— 浏览器半：设置 → 插件 → 「SSH 服务器」。
 *
 * ## 这个页面为什么存在
 *
 * Host 半把服务器清单放 `<DSH_HOME>/dsh-ssh/servers.json`、密码放凭据库。模型通过
 * 工具就能增删服务器，但用户不该为了改一个密码把密码粘进对话。所以这里画一张自己的
 * 卡片：加服务器、改密码、测连接都在 GUI 里完成，密码只从 `type=password` 的输入框
 * 直接进 Host 的凭据库，从不回显、从不落进配置。
 *
 * ## 为什么是手写 bundle
 *
 * `dsh.client` 只要求 `exports["./client"]` 解析出一个 JS 文件，DSH 的模块清单会在
 * `/plugins/dsh-ssh/client.js` 上提供它。`require` 只能解析 shell 静态模块表里的两个
 * 说明符（见工厂里的注释），所以界面元素一律用原生 DOM 元素 + 内联样式画，不引任何
 * 内部 CSS class —— 那些 class 是模块私有的，随版本变。
 *
 * ## 三个必须一起改的字符串
 *
 * `SETTINGS_NS` 是设置命名空间，也就是 Loader 行 id（Host 半 `index.js` 的 `name`
 * 导出）；`NS` 是本页自己的词典命名空间；`RPC_CHANNEL` 是 Host 半 `lib/rpc.mjs`
 * 注册的前缀路由。任何一个对不上都不会报错，只会表现为「页面不出现」或「按钮没反应」。
 *
 * ## 数据怎么来
 *
 * 普通配置字段（默认服务器 / 输出上限 / 连接超时）走 `SettingsFormModel` 的
 * 「暂存 → 保存」，由设置服务持久化；服务器清单没有对应的 Config 字段（它是运行时
 * 数据），走 Host 半自建的 `/dsh-ssh` RPC 通道。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ssh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // 静态模块表里只有这两个说明符可解析（官方设置页用的正是同一对）。引别的会抛
    // `client-modules: require("…") missed the module table`，而且只在浏览器里报。
    const { jsx, jsxs } = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');

    // #region 词典
    /** 英文文案。 */
    const en = {
      title: 'SSH servers',
      description: 'Connect to SSH servers: run commands, upload and download files, keep long jobs running.',

      servers: 'Servers',
      serversHint: 'The agent addresses a server by name, so host details never have to be repeated in a conversation.',
      empty: 'No servers yet. Add one below.',
      loading: 'Loading…',
      refresh: 'Refresh',
      retry: 'Retry',
      addServer: 'Add server',
      editServer: 'Edit server',
      missingServer: 'missing',

      name: 'Name',
      nameHint: 'Letters, digits, dot, underscore and dash; this is what the agent uses to pick the server.',
      host: 'Host',
      port: 'Port',
      user: 'User',
      auth: 'Authentication',
      authPassword: 'Password',
      authKey: 'Private key',
      password: 'Password',
      passwordHint: 'Stored in the credential store, never in the settings file. Leave blank to keep the current one.',
      passwordSet: 'Password configured',
      passwordUnset: '⚠ No password yet',
      keyPath: 'Private key path',
      keyPathHint: 'Absolute path to a key file on this machine.',
      passphrase: 'Key passphrase (optional)',
      passphraseHint: 'Only needed when the key file is encrypted.',
      note: 'Note',
      noteHint: 'Free text, for example what this machine is used for.',
      defaultRemoteDir: 'Default remote directory',
      defaultRemoteDirHint: 'Working directory for commands that do not set one.',
      cwdLabel: 'cwd',

      test: 'Test',
      testing: 'Testing…',
      testPassed: 'Connected',
      testFailed: 'Connection failed',
      setPassword: 'Set password',
      passwordPrompt: 'New password',
      storePassword: 'Store',
      remove: 'Delete',
      removeConfirm: 'Delete this server?',
      removeYes: 'Delete',
      removeNo: 'Keep',

      added: 'Server added.',
      updated: 'Server updated.',
      removed: 'Server deleted.',
      passwordStored: 'Password stored.',

      defaults: 'Defaults',
      defaultsHint: 'Used by every tool call that does not name a server or override the value.',
      defaultHost: 'Default server',
      defaultHostHint: 'Picked when a tool call does not name one.',
      noDefaultHost: 'No default — name a server explicitly',
      maxOutputBytes: 'Maximum output per stream',
      maxOutputBytesHint: 'Bytes, 1024–1048576. Output beyond this is truncated.',
      connectTimeoutMs: 'Connection timeout',
      connectTimeoutMsHint: 'Milliseconds, 1000–120000.',
      preferLocalRelay: 'Prefer downloading locally, then uploading',
      preferLocalRelayHint:
        'On: download on the machine running dsh, then upload over SFTP (best when the server has slow or restricted outbound access). Off: let the server fetch the URL itself with curl/wget.',

      storage: 'Storage',
      storageFile: 'Servers file',
      secretStore: 'Secrets',
      build: 'Build',
      storageUnavailable: 'The Host did not report its storage location.',
      secretStoreCredentials: 'dsh credential store',
      secretStoreFile: 'encrypted file',

      nameRequired: 'A name is required.',
      nameInvalid: 'Use letters, digits, dot, underscore or dash (must start with a letter or digit, at most 64 characters).',
      hostRequired: 'A host is required.',
      userRequired: 'A user is required.',
      portInvalid: 'The port must be an integer between 1 and 65535.',
      keyPathRequired: 'A private key path is required for key authentication.',
      actionFailed: 'The action failed.',
      loadFailed: 'Could not load the server list',

      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      cancel: 'Cancel'
    };

    /** 简体中文文案。 */
    const zh = {
      title: 'SSH 服务器',
      description: '直接连接 SSH 服务器：执行命令、上传下载文件、跑后台长任务。',

      servers: '服务器',
      serversHint: 'agent 按名字选服务器，所以不必在对话里反复写主机地址。',
      empty: '还没有服务器。在下面添加一台。',
      loading: '加载中…',
      refresh: '刷新',
      retry: '重试',
      addServer: '添加服务器',
      editServer: '编辑服务器',
      missingServer: '已不存在',

      name: '名称',
      nameHint: '字母、数字、点、下划线、短横线；agent 用它来选择服务器。',
      host: '主机',
      port: '端口',
      user: '用户名',
      auth: '认证方式',
      authPassword: '密码',
      authKey: '私钥',
      password: '密码',
      passwordHint: '存进凭据库，不写进配置文件。留空表示保持当前密码。',
      passwordSet: '已配置密码',
      passwordUnset: '⚠ 尚未配置密码',
      keyPath: '私钥路径',
      keyPathHint: '本机私钥文件的绝对路径。',
      passphrase: '私钥口令（可选）',
      passphraseHint: '仅当私钥文件有口令时需要。',
      note: '备注',
      noteHint: '自由文本，例如这台机器用来做什么。',
      defaultRemoteDir: '默认远程目录',
      defaultRemoteDirHint: '工具调用没有指定工作目录时用它。',
      cwdLabel: '工作目录',

      test: '测试连接',
      testing: '连接中…',
      testPassed: '连接成功',
      testFailed: '连接失败',
      setPassword: '设置密码',
      passwordPrompt: '新密码',
      storePassword: '保存密码',
      remove: '删除',
      removeConfirm: '确定删除这台服务器？',
      removeYes: '确认删除',
      removeNo: '保留',

      added: '服务器已添加。',
      updated: '服务器已更新。',
      removed: '服务器已删除。',
      passwordStored: '密码已保存。',

      defaults: '默认行为',
      defaultsHint: '工具调用没有指定服务器或没有覆盖该值时使用这里的配置。',
      defaultHost: '默认服务器',
      defaultHostHint: '工具调用没有指定服务器时用它。',
      noDefaultHost: '不设默认 — 每次显式指定服务器',
      maxOutputBytes: '单次输出上限',
      maxOutputBytesHint: '单位字节，1024–1048576。超出部分会被截断。',
      connectTimeoutMs: '连接超时',
      connectTimeoutMsHint: '单位毫秒，1000–120000。',
      preferLocalRelay: '优先本地下载后上传',
      preferLocalRelayHint:
        '开启：先在运行 dsh 的这台机器下载，再上传到服务器（适合服务器外网慢或受限）。关闭：让服务器自己用 curl/wget 取。',

      storage: '存储位置',
      storageFile: '服务器清单',
      secretStore: '密钥存储',
      build: '构建',
      storageUnavailable: 'Host 没有报告存储位置。',
      secretStoreCredentials: 'dsh 凭据服务',
      secretStoreFile: '加密文件',

      nameRequired: '必须填写名称。',
      nameInvalid: '只能使用字母、数字、点、下划线或短横线（必须以字母或数字开头，最多 64 个字符）。',
      hostRequired: '必须填写主机。',
      userRequired: '必须填写用户名。',
      portInvalid: '端口必须是 1 到 65535 之间的整数。',
      keyPathRequired: '私钥认证必须填写私钥路径。',
      actionFailed: '操作失败。',
      loadFailed: '无法加载服务器清单',

      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      cancel: '取消'
    };
    // #endregion

    // #region 常量
    /**
     * 本页的词典命名空间。
     *
     * 与下面的设置命名空间同名是刻意的：一个字符串既能当槽位词典键，也便于在
     * 开发者工具里定位；两者是不同服务里的独立键，不冲突。
     */
    const NS = 'dsh-ssh';

    /**
     * 设置命名空间 = Loader 行 id = Host 半的 `name`。
     *
     * 客户端不能 import Host 包，所以这个字符串在这里重复一遍。改名时必须同时改
     * `cordis.patch.yml` 的行 id 与 `index.js` 的 `SETTINGS_NAMESPACE`，否则
     * `whileServed` 永远为假、页面静默消失。
     */
    const SETTINGS_NS = 'dsh-ssh';

    /** 槽位 id：用自己的 id 并排新增，复用别人的 id 会顶掉别人的页面。 */
    const SLOT_ID = 'dsh-ssh';

    /** 槽位顺序：官方「网页搜索」是 40，这里紧随其后。 */
    const SLOT_ORDER = 41;

    /** Host 半 `lib/rpc.mjs` 注册的前缀路由。 */
    const RPC_CHANNEL = '/dsh-ssh';

    /** 失败 / 成功 / 警示色，与内置设置页的语义色一致。 */
    const COLOR_ERROR = '#d92d20';
    const COLOR_SUCCESS = '#12805c';
    const COLOR_WARNING = '#b54708';

    /** 自定义行与内置字段行之间的分隔线。 */
    const SEPARATOR = '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))';

    /** 一行「标签 + 控件 + 提示」的容器。 */
    const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' };

    /** 字段标签。 */
    const LABEL_STYLE = {
      fontSize: '13px',
      fontWeight: 500,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary, inherit)'
    };

    /** 提示文字。 */
    const HINT_STYLE = {
      margin: 0,
      fontSize: '12px',
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-tertiary, inherit)'
    };

    /** 灰色圆角面板：把一组字段包起来，和内置的字段分组视觉一致。 */
    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      margin: '8px 0 4px',
      padding: '2px 16px',
      background: 'rgba(128, 128, 128, 0.09)',
      borderRadius: '12px'
    };

    /** 区块外框。 */
    const SECTION_STYLE = { padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '6px' };

    /** 区块标题。 */
    const SECTION_TITLE_STYLE = { margin: 0, fontSize: '13px', fontWeight: 600, lineHeight: 1.5 };

    /** 按钮行的布局。 */
    const BUTTON_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' };

    /** 一台服务器一行。 */
    const ROW_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '10px 0',
      borderBottom: SEPARATOR
    };

    /** 行首：名字 + `user@host:port` + 徽标。 */
    const ROW_HEAD_STYLE = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' };

    /** 服务器名字。 */
    const NAME_STYLE = { fontSize: '13px', fontWeight: 600, lineHeight: 1.5 };

    /** `user@host:port`：等宽，便于竖向比对。 */
    const TARGET_STYLE = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: 1.6,
      opacity: 0.75,
      wordBreak: 'break-all'
    };

    /** 一行信息（标签 + 值），用于存储区。 */
    const INFO_ROW_STYLE = { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: 1.6, minWidth: 0 };

    /** 结果 / 错误文案。 */
    const RESULT_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.5 };

    /** 空态占位。 */
    const EMPTY_STYLE = { margin: '4px 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.6 };
    // #endregion

    // #region 辅助函数
    /**
     * 任意抛出值 → 展示文案。
     *
     * RPC 的传输层错误是真正的异常（HTTP 非 2xx、信封损坏），业务错误则走
     * `{ ok:false, error }`；两条路都要能变成一行字给用户看。
     *
     * @param {unknown} error - 抛出值。
     * @returns {string} 展示文案。
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }

    /**
     * RPC 失败信封 → 展示文案。
     *
     * Host 的失败形状是 `{ ok:false, error:{ code, message, details } }`。`message`
     * 是人话（Host 抛出的错误原文），`code` 只在存在时作为前缀帮助定位。
     *
     * @param {any} error - `result.error`。
     * @returns {string} 展示文案，可能为空串。
     */
    function describeRpcError(error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
      if (message !== '' && code !== '') return `${message}（${code}）`;
      if (message !== '') return message;
      if (code !== '') return code;
      return '';
    }

    /**
     * 共享设置表单渲染的固定标签。
     *
     * @param {(key: string) => string} t - 词典读取器。
     * @returns {Record<string, string>} SettingsForm 的 labels。
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving')
      };
    }

    /**
     * 输入框样式：模仿内置字段的输入框，避免引内部 class。
     *
     * @param {boolean} disabled - 是否禁用。
     * @returns {Record<string, any>} 内联样式。
     */
    function inputStyle(disabled) {
      return {
        width: '100%',
        height: '34px',
        padding: '0 12px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'text'
      };
    }

    /**
     * 下拉框样式，与输入框同形。
     *
     * @param {boolean} disabled - 是否禁用。
     * @returns {Record<string, any>} 内联样式。
     */
    function selectStyle(disabled) {
      return {
        width: '100%',
        height: '34px',
        padding: '0 12px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.06))',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, inherit)',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
    }

    /**
     * 按钮样式。
     *
     * `primary` 用于「添加 / 保存」这类推进动作，`danger` 用于删除，其余是描边次要
     * 按钮。颜色用 CSS 变量并带 fallback，主题换色时不必改代码。
     *
     * @param {'primary'|'secondary'|'danger'} variant - 变体。
     * @param {boolean} disabled - 是否禁用。
     * @returns {Record<string, any>} 内联样式。
     */
    function buttonStyle(variant, disabled) {
      const base = {
        height: '32px',
        padding: '0 14px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer'
      };
      if (variant === 'primary') {
        return {
          ...base,
          border: 'none',
          background: 'var(--dsw-alias-brand-primary, #ff5a1f)',
          color: '#ffffff'
        };
      }
      if (variant === 'danger') {
        return {
          ...base,
          border: '0.5px solid currentColor',
          background: 'transparent',
          color: COLOR_ERROR
        };
      }
      return {
        ...base,
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)'
      };
    }

    /**
     * 一个状态徽标。用 `currentColor` 描边，所以只给文字色即可。
     *
     * @param {{ text: string, tone?: 'neutral'|'success'|'warning'|'error' }} props - 徽标内容。
     * @returns {any} 元素。
     */
    function Badge(props) {
      const tone = props.tone === undefined ? 'neutral' : props.tone;
      const color =
        tone === 'error'
          ? COLOR_ERROR
          : tone === 'warning'
            ? COLOR_WARNING
            : tone === 'success'
              ? COLOR_SUCCESS
              : 'inherit';
      return jsx('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          fontSize: '11px',
          lineHeight: 1.4,
          padding: '1px 8px',
          borderRadius: '999px',
          border: '0.5px solid currentColor',
          color,
          opacity: tone === 'neutral' ? 0.65 : 1,
          whiteSpace: 'nowrap'
        },
        children: props.text
      });
    }

    /**
     * 一行「标签 + 输入框 + 提示」。
     *
     * 内置的 `SettingsValueField` 只读写配置命名空间里的字段，而添加 / 编辑服务器
     * 的草稿不在配置里（它是一次性的 RPC 参数），所以这一行自己画。
     *
     * @param {any} props - `{ id, label, hint, value, type?, placeholder?, disabled?, onChange }`。
     * @returns {any} 元素。
     */
    function TextRow(props) {
      const id = props.id;
      const describedBy = `${id}-hint`;
      const disabled = props.disabled === true;
      return jsxs('div', {
        style: { ...FIELD_STYLE, padding: '10px 0' },
        children: [
          jsx('label', { htmlFor: id, style: LABEL_STYLE, children: props.label }),
          jsx('input', {
            id,
            type: props.type === 'password' ? 'password' : 'text',
            value: props.value,
            disabled,
            placeholder: props.placeholder === undefined ? undefined : props.placeholder,
            // 密码框禁用浏览器自动填充：这里填的是待写入凭据库的新值，不是登录表单。
            autoComplete: props.type === 'password' ? 'new-password' : 'off',
            spellCheck: false,
            'aria-describedby': props.hint === undefined ? undefined : describedBy,
            onChange: (event) => {
              props.onChange(event.target.value);
            },
            style: inputStyle(disabled)
          }),
          props.hint === undefined ? null : jsx('p', { id: describedBy, style: HINT_STYLE, children: props.hint })
        ]
      });
    }

    /**
     * 一行「标签 + 下拉框 + 提示」。
     *
     * 设置表单里的「默认服务器」和草稿表单里的「认证方式」都需要它；内置字段种类
     * 只有文本与数字，没有下拉。
     *
     * @param {any} props - `{ id, label, hint?, value, options, disabled?, controlKey?, onChange }`。
     * @returns {any} 元素。
     */
    function SelectRow(props) {
      const id = props.id;
      const describedBy = `${id}-hint`;
      const disabled = props.disabled === true;
      return jsxs('div', {
        style: { ...FIELD_STYLE, padding: '10px 0' },
        children: [
          jsx('label', { htmlFor: id, style: LABEL_STYLE, children: props.label }),
          jsx('select', {
            id,
            style: selectStyle(disabled),
            value: props.value,
            disabled,
            'aria-describedby': props.hint === undefined ? undefined : describedBy,
            onChange: (event) => {
              props.onChange(event.target.value);
            },
            children: props.options.map((option) =>
              jsx('option', { value: option.value, children: option.label }, `${id}:${option.value}`)
            )
          }),
          props.hint === undefined ? null : jsx('p', { id: describedBy, style: HINT_STYLE, children: props.hint })
        ]
      });
    }

    /**
     * 一行「标签 + 开关 + 提示」。
     *
     * `SettingsFormModel` 的内置字段种类只有文本与数字，布尔要自己给出 format/parse；
     * 渲染侧同样没有内置开关行，所以用导出的 `Switch` 原语拼一行与上面两种控件同形的
     * 布局（标签在左、开关在右、提示在下）。
     *
     * @param {any} props - `{ id, label, hint?, checked, disabled?, onChange }`。
     * @returns {any} 元素。
     */
    function ToggleRow(props) {
      const id = props.id;
      const describedBy = `${id}-hint`;
      const disabled = props.disabled === true;
      return jsxs('div', {
        style: { ...FIELD_STYLE, padding: '10px 0' },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px' },
            children: [
              jsx('label', {
                htmlFor: id,
                style: { ...LABEL_STYLE, flex: '1 1 auto', minWidth: 0 },
                children: props.label
              }),
              jsx(P.Switch, {
                id,
                checked: props.checked,
                disabled,
                label: props.label,
                'aria-describedby': props.hint === undefined ? undefined : describedBy,
                onChange: (next) => {
                  props.onChange(next === true);
                }
              })
            ]
          }),
          props.hint === undefined ? null : jsx('p', { id: describedBy, style: HINT_STYLE, children: props.hint })
        ]
      });
    }

    /**
     * 存储区里的一行信息。
     *
     * @param {{ label: string, value: string, tone?: 'error' }} props - 内容。
     * @returns {any} 元素。
     */
    function InfoRow(props) {
      return jsxs('div', {
        style: INFO_ROW_STYLE,
        children: [
          jsx('span', { style: { flex: '0 0 auto', opacity: 0.6 }, children: props.label }),
          jsx('span', {
            style: {
              minWidth: 0,
              wordBreak: 'break-all',
              color: props.tone === 'error' ? COLOR_ERROR : 'inherit'
            },
            children: props.value
          })
        ]
      });
    }

    /**
     * 把 Host 报告的密钥存储种类翻成用户能读懂的名字。
     *
     * @param {(key: string) => string} t - 词典读取器。
     * @param {unknown} kind - `plugin.status.secretStore`。
     * @returns {string} 展示文案。
     */
    function describeSecretStore(t, kind) {
      if (kind === 'credentials-service') return t('secretStoreCredentials');
      if (kind === 'encrypted-file') return t('secretStoreFile');
      if (typeof kind === 'string' && kind !== '') return kind;
      return '—';
    }

    /**
     * 草稿 → `profiles.add` / `profiles.update` 的 payload。
     *
     * 空密码不放进 payload：Host 对 `password` 的处理是「非空才写入」，传空串会
     * 走一遍「不能为空」的校验分支，编辑时也会把已有密码当成要改。
     *
     * @param {any} draft - 表单草稿。
     * @returns {Record<string, any>} payload。
     */
    function buildProfilePayload(draft) {
      /** @type {Record<string, any>} */
      const payload = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: Number.parseInt(draft.port, 10),
        user: draft.user.trim(),
        auth: draft.auth,
        note: draft.note,
        defaultRemoteDir: draft.defaultRemoteDir.trim()
      };
      if (draft.auth === 'key') {
        payload.privateKeyPath = draft.privateKeyPath.trim();
        if (draft.passphrase !== '') payload.passphrase = draft.passphrase;
      } else if (draft.password !== '') {
        payload.password = draft.password;
      }
      return payload;
    }
    // #endregion

    // #region 组件
    /**
     * 一台服务器一行：名字、`user@host:port`、认证方式、密码状态、备注、行内动作。
     *
     * 行内动作都是即时的（直接调 RPC），不经过表单的「保存」。这样用户改完密码不用
     * 再记得点保存，也不会因为配置文件里有未保存的改动而困惑。
     *
     * @param {any} props - `{ t, profile, row, page }`。
     * @returns {any} 元素。
     */
    function ServerRow(props) {
      const t = props.t;
      const profile = props.profile;
      const row = props.row;
      const busy = row.busy;
      const rowDisabled = busy !== '';

      const authBadge = profile.auth === 'key' ? t('authKey') : t('authPassword');
      // 只有密码认证才有「配了没」这回事；私钥认证看的是文件路径，密码状态无意义。
      const passwordBadge =
        profile.auth === 'password'
          ? {
              text: profile.passwordConfigured ? t('passwordSet') : t('passwordUnset'),
              tone: profile.passwordConfigured ? 'success' : 'warning'
            }
          : null;

      /** @type {any[]} */
      const children = [
        jsxs('div', {
          style: ROW_HEAD_STYLE,
          children: [
            jsx('span', { style: NAME_STYLE, children: profile.name }),
            jsx('span', { style: TARGET_STYLE, children: `${profile.user}@${profile.host}:${profile.port}` }),
            jsx(Badge, { text: authBadge }),
            passwordBadge === null ? null : jsx(Badge, { text: passwordBadge.text, tone: passwordBadge.tone })
          ]
        })
      ];

      if (profile.note !== '') {
        children.push(jsx('p', { style: HINT_STYLE, children: profile.note }));
      }
      if (profile.defaultRemoteDir !== '') {
        children.push(
          jsx('p', { style: HINT_STYLE, children: `${t('cwdLabel')}: ${profile.defaultRemoteDir}` })
        );
      }
      if (profile.auth === 'key' && profile.privateKeyPath !== '') {
        children.push(jsx('p', { style: HINT_STYLE, children: `${t('keyPath')}: ${profile.privateKeyPath}` }));
      }

      // 动作按钮：测试 / 设置密码 / 编辑 / 删除。删除是两段式（同一行里变成
      // 「确认删除」+「保留」），不用 window.confirm —— 原生对话框在自动化验证里
      // 会阻塞页面，也会在浏览器禁弹窗时静默失败。
      /** @type {any[]} */
      const buttons = [
        jsx(
          'button',
          {
            type: 'button',
            style: buttonStyle('secondary', rowDisabled),
            disabled: rowDisabled,
            onClick: () => {
              props.page.testProfile(profile.name);
            },
            children: busy === 'test' ? t('testing') : t('test')
          },
          'test'
        )
      ];
      if (passwordBadge !== null) {
        buttons.push(
          jsx(
            'button',
            {
              type: 'button',
              style: buttonStyle('secondary', rowDisabled),
              disabled: rowDisabled,
              onClick: () => {
                props.page.togglePassword(profile.name);
              },
              children: row.passwordOpen ? t('cancel') : t('setPassword')
            },
            'password'
          )
        );
      }
      buttons.push(
        jsx(
          'button',
          {
            type: 'button',
            style: buttonStyle('secondary', rowDisabled),
            disabled: rowDisabled,
            onClick: () => {
              props.page.startEdit(profile.name);
            },
            children: t('editServer')
          },
          'edit'
        )
      );
      if (row.confirmRemove) {
        buttons.push(
          jsx(
            'button',
            {
              type: 'button',
              style: buttonStyle('danger', rowDisabled),
              disabled: rowDisabled,
              onClick: () => {
                props.page.removeProfile(profile.name);
              },
              children: busy === 'remove' ? t('saving') : t('removeYes')
            },
            'removeYes'
          )
        );
        buttons.push(
          jsx(
            'button',
            {
              type: 'button',
              style: buttonStyle('secondary', rowDisabled),
              disabled: rowDisabled,
              onClick: () => {
                props.page.toggleDelete(profile.name);
              },
              children: t('removeNo')
            },
            'removeNo'
          )
        );
      } else {
        buttons.push(
          jsx(
            'button',
            {
              type: 'button',
              style: buttonStyle('danger', rowDisabled),
              disabled: rowDisabled,
              onClick: () => {
                props.page.toggleDelete(profile.name);
              },
              children: t('remove')
            },
            'remove'
          )
        );
      }
      // 确认态先给一句说明再给按钮：只换成两个按钮的话，用户会不确定刚点的是哪一台。
      if (row.confirmRemove) {
        children.push(
          jsx('p', { style: { ...RESULT_STYLE, color: COLOR_ERROR }, children: t('removeConfirm') }, 'removeConfirm')
        );
      }
      children.push(jsx('div', { style: BUTTON_ROW_STYLE, children: buttons }, 'actions'));

      // 密码输入：只在点开时出现；值是受控的，提交成功后清空。绝不把它拼进任何
      // 文本片段 —— 页面上唯一的明面是 input 自身。
      if (row.passwordOpen) {
        children.push(
          jsxs(
            'div',
            {
              style: { ...BUTTON_ROW_STYLE, marginTop: '2px' },
              children: [
                jsx(
                  'input',
                  {
                    type: 'password',
                    value: row.password,
                    placeholder: t('passwordPrompt'),
                    autoComplete: 'new-password',
                    spellCheck: false,
                    onChange: (event) => {
                      props.page.passwordField(profile.name, event.target.value);
                    },
                    style: { ...inputStyle(false), flex: '1 1 220px', width: 'auto' },
                    'aria-label': t('passwordPrompt')
                  },
                  'input'
                ),
                jsx(
                  'button',
                  {
                    type: 'button',
                    style: buttonStyle('primary', row.password === '' || rowDisabled),
                    disabled: row.password === '' || rowDisabled,
                    onClick: () => {
                      props.page.savePassword(profile.name);
                    },
                    children: busy === 'password' ? t('saving') : t('storePassword')
                  },
                  'store'
                ),
                jsx(
                  'button',
                  {
                    type: 'button',
                    style: buttonStyle('secondary', rowDisabled),
                    disabled: rowDisabled,
                    onClick: () => {
                      props.page.togglePassword(profile.name);
                    },
                    children: t('cancel')
                  },
                  'cancel'
                )
              ]
            },
            'passwordRow'
          )
        );
      }

      if (row.test !== null) {
        const parts = [];
        if (row.test.hostname) parts.push(String(row.test.hostname));
        if (row.test.platform) parts.push(String(row.test.platform));
        if (typeof row.test.latencyMs === 'number') parts.push(`${row.test.latencyMs} ms`);
        children.push(
          jsx(
            'p',
            { style: { ...RESULT_STYLE, color: COLOR_SUCCESS }, children: `${t('testPassed')} · ${parts.join(' · ')}` },
            'testResult'
          )
        );
      }
      if (row.testError !== '') {
        children.push(jsx('p', { style: { ...RESULT_STYLE, color: COLOR_ERROR }, children: `${t('testFailed')}: ${row.testError}` }, 'testError'));
      }
      if (row.error !== '') {
        children.push(jsx('p', { style: { ...RESULT_STYLE, color: COLOR_ERROR }, children: row.error }, 'rowError'));
      }

      return jsx('div', { style: ROW_STYLE, children });
    }

    /**
     * 添加 / 编辑服务器的草稿表单。
     *
     * 字段值来自 controller 的 `draft`（一次性 RPC 参数），与配置表单的「暂存 →
     * 保存」互不相干：这里按「本行保存」直接调 Host。
     *
     * @param {any} props - `{ t, state, page }`。
     * @returns {any} 元素。
     */
    function ProfileForm(props) {
      const t = props.t;
      const draft = props.state.draft;
      const busy = props.state.draftBusy;
      const editing = draft.mode === 'edit';

      /** @type {any[]} */
      const children = [
        jsx('p', {
          style: SECTION_TITLE_STYLE,
          children: editing ? t('editServer') : t('addServer')
        }),
        jsx(TextRow, {
          id: 'dsh-ssh-draft-name',
          label: t('name'),
          hint: t('nameHint'),
          value: draft.name,
          // 编辑时名称只读：Host 的 update 用 name 定位 profile，改名会变成「找不到」
          // 而不是「重命名」，界面上留一个可改的名字只会制造困惑。
          disabled: editing || busy,
          onChange: (value) => {
            props.page.draftField('name', value);
          }
        }),
        jsx(TextRow, {
          id: 'dsh-ssh-draft-host',
          label: t('host'),
          value: draft.host,
          disabled: busy,
          onChange: (value) => {
            props.page.draftField('host', value);
          }
        }),
        jsx(TextRow, {
          id: 'dsh-ssh-draft-port',
          label: t('port'),
          value: draft.port,
          disabled: busy,
          onChange: (value) => {
            props.page.draftField('port', value);
          }
        }),
        jsx(TextRow, {
          id: 'dsh-ssh-draft-user',
          label: t('user'),
          value: draft.user,
          disabled: busy,
          onChange: (value) => {
            props.page.draftField('user', value);
          }
        }),
        jsx(SelectRow, {
          id: 'dsh-ssh-draft-auth',
          label: t('auth'),
          value: draft.auth,
          disabled: busy,
          options: [
            { value: 'password', label: t('authPassword') },
            { value: 'key', label: t('authKey') }
          ],
          onChange: (value) => {
            props.page.draftField('auth', value);
          }
        })
      ];

      if (draft.auth === 'key') {
        children.push(
          jsx(TextRow, {
            id: 'dsh-ssh-draft-key-path',
            label: t('keyPath'),
            hint: t('keyPathHint'),
            value: draft.privateKeyPath,
            disabled: busy,
            onChange: (value) => {
              props.page.draftField('privateKeyPath', value);
            }
          })
        );
        children.push(
          jsx(TextRow, {
            id: 'dsh-ssh-draft-passphrase',
            label: t('passphrase'),
            hint: t('passphraseHint'),
            type: 'password',
            value: draft.passphrase,
            disabled: busy,
            onChange: (value) => {
              props.page.draftField('passphrase', value);
            }
          })
        );
      } else {
        children.push(
          jsx(TextRow, {
            id: 'dsh-ssh-draft-password',
            label: t('password'),
            hint: t('passwordHint'),
            type: 'password',
            value: draft.password,
            disabled: busy,
            onChange: (value) => {
              props.page.draftField('password', value);
            }
          })
        );
      }

      children.push(
        jsx(TextRow, {
          id: 'dsh-ssh-draft-note',
          label: t('note'),
          hint: t('noteHint'),
          value: draft.note,
          disabled: busy,
          onChange: (value) => {
            props.page.draftField('note', value);
          }
        }),
        jsx(TextRow, {
          id: 'dsh-ssh-draft-remote-dir',
          label: t('defaultRemoteDir'),
          hint: t('defaultRemoteDirHint'),
          value: draft.defaultRemoteDir,
          disabled: busy,
          onChange: (value) => {
            props.page.draftField('defaultRemoteDir', value);
          }
        })
      );

      if (props.state.draftError !== '') {
        children.push(
          jsx('p', { style: { ...RESULT_STYLE, color: COLOR_ERROR }, role: 'status', children: props.state.draftError })
        );
      }

      children.push(
        jsx('div', {
          style: { ...BUTTON_ROW_STYLE, padding: '10px 0 14px' },
          children: [
            jsx(
              'button',
              {
                type: 'button',
                style: buttonStyle('primary', busy),
                disabled: busy,
                onClick: () => {
                  props.page.submitDraft();
                },
                children: busy ? t('saving') : editing ? t('save') : t('addServer')
              },
              'submit'
            ),
            jsx(
              'button',
              {
                type: 'button',
                style: buttonStyle('secondary', busy),
                disabled: busy,
                onClick: () => {
                  props.page.cancelDraft();
                },
                children: t('cancel')
              },
              'cancel'
            )
          ]
        })
      );

      return jsx('div', { style: PANEL_STYLE, children }, 'draft');
    }

    /**
     * 服务器区块：标题、刷新 / 添加、加载态、错误重试、空态、行列表、草稿表单。
     *
     * @param {any} props - `{ t, state, page }`。
     * @returns {any} 元素。
     */
    function ServersSection(props) {
      const t = props.t;
      const state = props.state;

      /** @type {any[]} */
      const children = [
        jsxs(
          'div',
          {
            style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'baseline', gap: '8px', flex: '1 1 auto', minWidth: 0 },
                children: [
                  jsx('p', { style: SECTION_TITLE_STYLE, children: t('servers') }),
                  jsx('span', { style: { fontSize: '12px', opacity: 0.55 }, children: String(state.profiles.length) })
                ]
              }),
              jsx(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('secondary', state.loading),
                  disabled: state.loading,
                  onClick: () => {
                    props.page.reload();
                  },
                  children: state.loading ? t('loading') : t('refresh')
                },
                'refresh'
              ),
              jsx(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('primary', false),
                  onClick: () => {
                    props.page.startAdd();
                  },
                  children: t('addServer')
                },
                'add'
              )
            ]
          },
          'head'
        ),
        jsx('p', { style: HINT_STYLE, children: t('serversHint') }, 'hint')
      ];

      if (state.message !== null) {
        children.push(
          jsx(
            'p',
            {
              style: { ...RESULT_STYLE, color: state.message.tone === 'error' ? COLOR_ERROR : COLOR_SUCCESS },
              role: 'status',
              children: state.message.text
            },
            'message'
          )
        );
      }

      if (state.loading && state.profiles.length === 0) {
        children.push(jsx('p', { style: EMPTY_STYLE, children: t('loading') }, 'loading'));
      } else if (state.loadError !== '') {
        children.push(
          jsxs(
            'div',
            {
              style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
              children: [
                jsx('p', { style: { ...RESULT_STYLE, color: COLOR_ERROR }, children: `${t('loadFailed')}: ${state.loadError}` }),
                jsx(
                  'button',
                  {
                    type: 'button',
                    style: buttonStyle('secondary', false),
                    onClick: () => {
                      props.page.reload();
                    },
                    children: t('retry')
                  },
                  'retry'
                )
              ]
            },
            'loadError'
          )
        );
      } else if (state.profiles.length === 0) {
        children.push(jsx('p', { style: EMPTY_STYLE, children: t('empty') }, 'empty'));
      } else {
        children.push(
          jsx(
            'div',
            {
              style: { display: 'flex', flexDirection: 'column' },
              children: state.profiles.map((profile) =>
                jsx(
                  ServerRow,
                  {
                    t,
                    profile,
                    row: state.rows[profile.name] === undefined ? EMPTY_ROW : state.rows[profile.name],
                    page: props.page
                  },
                  profile.name
                )
              )
            },
            'list'
          )
        );
      }

      if (state.draft !== null) {
        children.push(jsx(ProfileForm, { t, state, page: props.page }, 'draft'));
      }

      return jsx('div', { style: SECTION_STYLE, children }, 'servers');
    }

    /**
     * 存储位置：方便用户排查「服务器清单到底写哪了」「密码存哪了」。
     *
     * 这一行不放密码或任何凭据内容，只放路径与种类。
     *
     * @param {any} props - `{ t, state }`。
     * @returns {any} 元素。
     */
    function StorageSection(props) {
      const t = props.t;
      const state = props.state;
      const status = state.status;

      /** @type {any[]} */
      const children = [
        jsx('p', { style: SECTION_TITLE_STYLE, children: t('storage') }, 'title')
      ];
      if (status === null) {
        children.push(
          jsx('p', { style: HINT_STYLE, children: state.statusError !== '' ? state.statusError : t('storageUnavailable') }, 'unavailable')
        );
      } else {
        children.push(
          jsx(InfoRow, { label: t('storageFile'), value: String(status.storeFile) }, 'file'),
          jsx(InfoRow, { label: t('secretStore'), value: describeSecretStore(t, status.secretStore) }, 'secrets'),
          jsx(InfoRow, { label: t('build'), value: String(status.version) }, 'build')
        );
      }
      return jsx('div', { style: { ...SECTION_STYLE, borderTop: SEPARATOR, gap: '2px' }, children }, 'storage');
    }

    /**
     * 插件页里的「SSH 服务器」卡片。
     *
     * `props.view === 'summary'` 时插件列表只要一句话；其余情况画完整页面。组件不
     * 持有本地状态：所有变化都来自 controller 注入的 `useSshCard` 快照，因此刷新
     * 列表、切草稿、测连接都不会因为一次重渲染而丢输入。
     *
     * @param {any} props - 槽位注入的 props。
     * @returns {any} 元素。
     */
    function SshCard(props) {
      const t = props.t;
      const state = props.useSshCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const valueLabels = {
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber')
      };

      // 「默认服务器」下拉：空值代表不设默认。当前值指向一台已不存在的服务器时补一个
      // 占位选项，否则原生 select 会静默显示第一项，看起来像默认值被清空了。
      const names = state.profiles.map((profile) => profile.name);
      // `text` 来自表单暂存；契约上是字符串，但原生 select 拿到 undefined 会让 React
      // 把 value 变成非受控，所以这里收口一次。
      const currentDefault =
        state.defaultHost === undefined || typeof state.defaultHost.text !== 'string' ? '' : state.defaultHost.text;
      const defaultOptions = [{ value: '', label: t('noDefaultHost') }].concat(
        names.map((name) => ({ value: name, label: name }))
      );
      if (currentDefault !== '' && names.indexOf(currentDefault) === -1) {
        defaultOptions.push({ value: currentDefault, label: `${currentDefault} (${t('missingServer')})` });
      }

      return jsxs(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: '4px' },
          children: [
            jsx(
              ServersSection,
              {
                t,
                state,
                page: {
                  reload: props.reload,
                  startAdd: props.startAdd,
                  startEdit: props.startEdit,
                  cancelDraft: props.cancelDraft,
                  draftField: props.draftField,
                  submitDraft: props.submitDraft,
                  testProfile: props.testProfile,
                  togglePassword: props.togglePassword,
                  passwordField: props.passwordField,
                  savePassword: props.savePassword,
                  toggleDelete: props.toggleDelete,
                  removeProfile: props.removeProfile
                }
              },
              'servers'
            ),
            jsx(
              P.SettingsForm,
              {
                labels: formLabels(t),
                state,
                onSave: props.save,
                onDiscard: props.discard,
                children: jsxs('div', {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    jsx('p', { style: SECTION_TITLE_STYLE, children: t('defaults') }, 'title'),
                    jsx('p', { style: HINT_STYLE, children: t('defaultsHint') }, 'hint'),
                    jsxs(
                      'div',
                      {
                        style: PANEL_STYLE,
                        children: [
                          jsx(
                            SelectRow,
                            {
                              id: 'dsh-ssh-default-host',
                              label: t('defaultHost'),
                              hint: t('defaultHostHint'),
                              value: currentDefault,
                              disabled: !state.writable,
                              options: defaultOptions,
                              onChange: (value) => {
                                props.edit('defaultHost', value);
                              }
                            },
                            'defaultHost'
                          ),
                          jsx(
                            P.SettingsValueField,
                            {
                              id: 'dsh-ssh-max-output-bytes',
                              label: t('maxOutputBytes'),
                              hint: t('maxOutputBytesHint'),
                              ...valueLabels,
                              numeric: true,
                              disabled: !state.writable,
                              ...state.maxOutputBytes,
                              onEdit: (text) => {
                                props.edit('maxOutputBytes', text);
                              },
                              onReset: () => {
                                props.resetField('maxOutputBytes');
                              }
                            },
                            'maxOutputBytes'
                          ),
                          jsx(
                            P.SettingsValueField,
                            {
                              id: 'dsh-ssh-connect-timeout',
                              label: t('connectTimeoutMs'),
                              hint: t('connectTimeoutMsHint'),
                              ...valueLabels,
                              numeric: true,
                              disabled: !state.writable,
                              ...state.connectTimeoutMs,
                              onEdit: (text) => {
                                props.edit('connectTimeoutMs', text);
                              },
                              onReset: () => {
                                props.resetField('connectTimeoutMs');
                              }
                            },
                            'connectTimeoutMs'
                          ),
                          jsx(
                            ToggleRow,
                            {
                              id: 'dsh-ssh-prefer-local-relay',
                              label: t('preferLocalRelay'),
                              hint: t('preferLocalRelayHint'),
                              // 与 Host 的默认语义一致：没有显式写 `false` 就是开启。
                              checked: state.preferLocalRelay.text !== 'false',
                              disabled: !state.writable,
                              onChange: (next) => {
                                props.edit('preferLocalRelay', next ? 'true' : 'false');
                              }
                            },
                            'preferLocalRelay'
                          )
                        ]
                      },
                      'fields'
                    )
                  ]
                })
              },
              'config'
            ),
            jsx(StorageSection, { t, state }, 'storage')
          ]
        }
      );
    }
    // #endregion

    // #region 状态
    /** 一行服务器在没有动作时的状态；共享的冻结对象，避免每次渲染造新对象。 */
    const EMPTY_ROW = Object.freeze({
      busy: '',
      test: null,
      testError: '',
      error: '',
      passwordOpen: false,
      password: '',
      confirmRemove: false
    });

    /** 一张空白的服务器草稿。 */
    function emptyDraft() {
      return {
        mode: 'add',
        name: '',
        host: '',
        port: '22',
        user: '',
        auth: 'password',
        password: '',
        privateKeyPath: '',
        passphrase: '',
        note: '',
        defaultRemoteDir: ''
      };
    }

    /**
     * 设置页的控制器：表单（配置字段）之外的全部状态都在这里。
     *
     * 为什么状态不放组件里：这个 bundle 只能 `require('react/jsx-runtime')`，拿不到
     * React 的 hooks（`useState` 之类）。所以页面是纯函数式的渲染，状态挂在
     * `form.bind()` 返回的 store 上，通过槽位注入的 `useSshCard` 订阅。
     */
    class SshCardController {
      /**
       * @param {any} scope - `dsh-ssh` 设置命名空间已绑定的设置作用域。
       * @param {any} ctx - 浏览器插件上下文（`connection.rpc`）。
       * @param {(key: string) => string} t - 本页词典读取器。
       */
      constructor(scope, ctx, t) {
        this.scope = scope;
        this.ctx = ctx;
        this.t = t;
        this.disposed = false;

        // 服务器清单与它的一次性状态。
        this.loading = true;
        this.loadError = '';
        /** @type {any[]} */
        this.profiles = [];
        /** @type {Record<string, any>} */
        this.rows = {};
        this.status = null;
        this.statusError = '';
        this.message = null;
        /** @type {any | null} */
        this.draft = null;
        this.draftBusy = false;
        this.draftError = '';

        // 四个 volatile 字段走设置服务的「暂存 → 保存」。textOrEmpty 而不是内置的
        // settingsTextField：内置文本字段把空串当成「清除覆盖」，而 defaultHost 的
        // 默认值本身就是空串，两者表现一样，但显式 set '' 更贴近用户点击「不设默认」
        // 的语义（也让「已覆盖」徽标在用户主动清空时消失得可控）。
        this.form = new P.SettingsFormModel(
          scope,
          [
            settingsTextOrEmptyField('defaultHost'),
            P.settingsNumberField('maxOutputBytes'),
            P.settingsNumberField('connectTimeoutMs'),
            settingsBooleanField('preferLocalRelay')
          ],
          []
        );
        this.store = this.form.bind(() => this.projection());

        // 挂载即拉一次清单与存储信息；设置页打开时用户看到的第一屏不该是空的。
        this.load();
      }

      /**
       * 页面快照：表单 shell + 四个配置字段的暂存态 + 本控制器的全部状态。
       *
       * @returns {Record<string, any>} 快照。
       */
      projection() {
        return {
          ...this.form.shell(),
          defaultHost: this.form.field('defaultHost'),
          maxOutputBytes: this.form.field('maxOutputBytes'),
          connectTimeoutMs: this.form.field('connectTimeoutMs'),
          preferLocalRelay: this.form.field('preferLocalRelay'),
          loading: this.loading,
          loadError: this.loadError,
          profiles: this.profiles,
          rows: this.rows,
          status: this.status,
          statusError: this.statusError,
          message: this.message,
          draft: this.draft,
          draftBusy: this.draftBusy,
          draftError: this.draftError
        };
      }

      /** 把当前快照推给页面。 */
      publish() {
        if (this.disposed) return;
        this.store.set(this.projection());
      }

      /**
       * 调一个 Host RPC 方法。
       *
       * `ctx.connection.rpc.call` 的返回信封是 `{ ok:true, value }` 或
       * `{ ok:false, error:{ code, message, details } }`；只有传输层错误才抛异常。
       * 这里把两种失败都翻成一句人话抛出，调用方统一 `catch`。
       *
       * @param {string} method - `plugin.status` / `profiles.list` 等。
       * @param {Record<string, any>} [payload] - 方法参数。
       * @returns {Promise<any>} 成功时的 `value`。
       */
      async call(method, payload) {
        const result = await this.ctx.connection.rpc.call(RPC_CHANNEL, method, payload === undefined ? {} : payload);
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        const text = describeRpcError(result === null || result === undefined ? undefined : result.error);
        throw new Error(text !== '' ? text : this.t('actionFailed'));
      }

      /** 拉一次服务器清单与存储位置。`plugin.status` 失败不影响清单展示。 */
      async load() {
        if (this.disposed) return;
        this.loading = true;
        this.loadError = '';
        this.publish();
        try {
          const list = await this.call('profiles.list');
          /** @type {any} */
          let status = null;
          try {
            status = await this.call('plugin.status');
          } catch {
            status = null;
          }
          if (this.disposed) return;
          this.profiles = list !== null && typeof list === 'object' && Array.isArray(list.profiles) ? list.profiles : [];
          this.status = status;
          this.statusError = '';
          // 已删除的服务器不该继续占着行状态（密码草稿、错误提示等）。
          const live = {};
          for (const profile of this.profiles) {
            if (this.rows[profile.name] !== undefined) live[profile.name] = this.rows[profile.name];
          }
          this.rows = live;
        } catch (error) {
          if (this.disposed) return;
          this.loadError = messageOf(error);
          this.statusError = '';
        } finally {
          if (!this.disposed) {
            this.loading = false;
            this.publish();
          }
        }
      }

      /**
       * 取一行状态。
       *
       * @param {string} name - 服务器名。
       * @returns {any} 行状态（不存在时是一张空行）。
       */
      rowOf(name) {
        const row = this.rows[name];
        return row === undefined ? EMPTY_ROW : row;
      }

      /**
       * 合并更新一行状态。
       *
       * @param {string} name - 服务器名。
       * @param {Record<string, any>} patch - 要改的字段。
       * @returns {void}
       */
      patchRow(name, patch) {
        this.rows = { ...this.rows, [name]: { ...this.rowOf(name), ...patch } };
      }

      /** 打开「添加服务器」草稿。重复点会把已填的内容清掉，这是明确的「重新开始」。 */
      startAdd() {
        this.draft = emptyDraft();
        this.draftError = '';
        this.message = null;
        this.publish();
      }

      /**
       * 打开编辑草稿，用现有 profile 回填；密码与口令留空（不回显、也不需要回显）。
       *
       * @param {string} name - 服务器名。
       * @returns {void}
       */
      startEdit(name) {
        const profile = this.profiles.find((item) => item.name === name);
        if (profile === undefined) return;
        this.draft = {
          mode: 'edit',
          name: profile.name,
          host: profile.host,
          port: String(profile.port),
          user: profile.user,
          auth: profile.auth,
          password: '',
          privateKeyPath: profile.privateKeyPath === undefined ? '' : profile.privateKeyPath,
          passphrase: '',
          note: profile.note,
          defaultRemoteDir: profile.defaultRemoteDir
        };
        this.draftError = '';
        this.message = null;
        this.publish();
      }

      /** 收起草稿，丢弃未提交的输入。 */
      cancelDraft() {
        this.draft = null;
        this.draftError = '';
        this.publish();
      }

      /**
       * 改草稿里的一个字段。
       *
       * @param {string} key - 字段名。
       * @param {string} value - 新值（`port` 也先按字符串存，提交时再转数字）。
       * @returns {void}
       */
      draftField(key, value) {
        if (this.draft === null) return;
        this.draft = { ...this.draft, [key]: value };
        this.publish();
      }

      /**
       * 校验草稿。客户端先挡一遍明显错误，Host 的 `normalizeProfile` 仍是最终裁判。
       *
       * @param {any} draft - 草稿。
       * @returns {string} 第一条错误文案，合法时为空串。
       */
      validateDraft(draft) {
        const name = draft.name.trim();
        if (name === '') return this.t('nameRequired');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return this.t('nameInvalid');
        if (draft.host.trim() === '') return this.t('hostRequired');
        if (draft.user.trim() === '') return this.t('userRequired');
        const port = Number.parseInt(draft.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return this.t('portInvalid');
        if (draft.auth === 'key' && draft.privateKeyPath.trim() === '') return this.t('keyPathRequired');
        return '';
      }

      /** 提交草稿：添加或更新一台服务器，成功后刷新清单并收起表单。 */
      async submitDraft() {
        const draft = this.draft;
        if (draft === null || this.draftBusy || this.disposed) return;
        const invalid = this.validateDraft(draft);
        if (invalid !== '') {
          this.draftError = invalid;
          this.publish();
          return;
        }
        this.draftBusy = true;
        this.draftError = '';
        this.publish();
        try {
          const payload = buildProfilePayload(draft);
          if (draft.mode === 'add') {
            await this.call('profiles.add', payload);
            if (!this.disposed) this.message = { tone: 'success', text: this.t('added') };
          } else {
            await this.call('profiles.update', payload);
            if (!this.disposed) this.message = { tone: 'success', text: this.t('updated') };
          }
          if (this.disposed) return;
          this.draft = null;
          await this.load();
        } catch (error) {
          if (this.disposed) return;
          this.draftError = messageOf(error);
        } finally {
          if (!this.disposed) {
            this.draftBusy = false;
            this.publish();
          }
        }
      }

      /**
       * 测试一台服务器：连上去并取 hostname / 内核 / uptime / 往返耗时。
       *
       * @param {string} name - 服务器名。
       * @returns {Promise<void>} 完成。
       */
      async testProfile(name) {
        if (this.disposed || this.rowOf(name).busy !== '') return;
        this.patchRow(name, { busy: 'test', test: null, testError: '', error: '' });
        this.publish();
        try {
          const value = await this.call('profiles.test', { name });
          if (this.disposed) return;
          const test = value !== null && typeof value === 'object' && value.test !== undefined ? value.test : null;
          this.patchRow(name, { test, testError: '' });
        } catch (error) {
          if (this.disposed) return;
          this.patchRow(name, { test: null, testError: messageOf(error) });
        } finally {
          if (!this.disposed) {
            this.patchRow(name, { busy: '' });
            this.publish();
          }
        }
      }

      /**
       * 展开 / 收起某一行的密码输入框。收起时丢掉已输入的内容（不留在内存里）。
       *
       * @param {string} name - 服务器名。
       * @returns {void}
       */
      togglePassword(name) {
        const row = this.rowOf(name);
        this.patchRow(name, { passwordOpen: !row.passwordOpen, password: '', error: '' });
        this.publish();
      }

      /**
       * 暂存一行密码输入框的内容。
       *
       * @param {string} name - 服务器名。
       * @param {string} text - 输入框当前值。
       * @returns {void}
       */
      passwordField(name, text) {
        this.patchRow(name, { password: text });
        this.publish();
      }

      /**
       * 把暂存的密码写进凭据库，然后刷新清单（`passwordConfigured` 会变）。
       *
       * @param {string} name - 服务器名。
       * @returns {Promise<void>} 完成。
       */
      async savePassword(name) {
        const row = this.rowOf(name);
        if (this.disposed || row.busy !== '' || row.password === '') return;
        this.patchRow(name, { busy: 'password', error: '' });
        this.publish();
        try {
          await this.call('profiles.password', { name, password: row.password });
          if (this.disposed) return;
          this.patchRow(name, { busy: '', passwordOpen: false, password: '' });
          this.message = { tone: 'success', text: this.t('passwordStored') };
          await this.load();
        } catch (error) {
          if (this.disposed) return;
          this.patchRow(name, { busy: '', error: messageOf(error) });
        } finally {
          if (!this.disposed) this.publish();
        }
      }

      /**
       * 删除的两段式确认：第一次点把按钮换成「确认删除 / 保留」。
       *
       * @param {string} name - 服务器名。
       * @returns {void}
       */
      toggleDelete(name) {
        const row = this.rowOf(name);
        this.patchRow(name, { confirmRemove: !row.confirmRemove, error: '' });
        this.publish();
      }

      /**
       * 删除一台服务器。
       *
       * @param {string} name - 服务器名。
       * @returns {Promise<void>} 完成。
       */
      async removeProfile(name) {
        if (this.disposed || this.rowOf(name).busy !== '') return;
        this.patchRow(name, { busy: 'remove', error: '' });
        this.publish();
        try {
          await this.call('profiles.remove', { name });
          if (this.disposed) return;
          const rows = { ...this.rows };
          delete rows[name];
          this.rows = rows;
          // 正在编辑被删掉的那台时收起草稿，否则保存会报「找不到服务器」。
          if (this.draft !== null && this.draft.mode === 'edit' && this.draft.name === name) this.draft = null;
          this.message = { tone: 'success', text: this.t('removed') };
          await this.load();
        } catch (error) {
          if (this.disposed) return;
          this.patchRow(name, { busy: '', error: messageOf(error) });
        } finally {
          if (!this.disposed) this.publish();
        }
      }

      /**
       * 槽位注入的「面孔」：一个 hooks 表 + 页面要调的全部动作。
       *
       * hooks 的 key 会被壳转成 `use<Key>` 函数（`sshCard` → `useSshCard`），页面组件
       * 靠它订阅快照；其余键直接成为组件 props。
       *
       * @returns {Record<string, any>} 注入对象。
       */
      inject() {
        return {
          hooks: { sshCard: this.store },
          ...this.form.actions(),
          reload: () => this.load(),
          startAdd: () => this.startAdd(),
          startEdit: (name) => this.startEdit(name),
          cancelDraft: () => this.cancelDraft(),
          draftField: (key, value) => this.draftField(key, value),
          submitDraft: () => this.submitDraft(),
          testProfile: (name) => this.testProfile(name),
          togglePassword: (name) => this.togglePassword(name),
          passwordField: (name, text) => this.passwordField(name, text),
          savePassword: (name) => this.savePassword(name),
          toggleDelete: (name) => this.toggleDelete(name),
          removeProfile: (name) => this.removeProfile(name)
        };
      }

      /** 释放表单订阅。RPC 是即时的，没有轮询或定时器要清。 */
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.form.dispose();
      }
    }

    /**
     * {@link P.SettingsFormModel} 的一种文本字段：空串按「写入空串」而不是「清除」处理。
     *
     * `defaultHost` 的 schema 默认值就是 `''`，所以两种语义最终值相同；显式 `set`
     * 让「用户选了不设默认」和「这个字段从未被覆盖」在暂存层保持可区分。
     *
     * @param {string} field - 配置字段名。
     * @returns {any} 字段规格。
     */
    function settingsTextOrEmptyField(field) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => ({ kind: 'set', value: text })
      };
    }

    /**
     * {@link P.SettingsFormModel} 的一种布尔字段。
     *
     * 内置字段种类没有布尔，所以自己给一对 `format` / `parse`：存储值 → 暂存文本，
     * 暂存文本 → 一次写入。`format` 只在值**显式**为 `false` 时返回 `'false'`，
     * 其余（`true` 或缺省）都当 `'true'` —— 与 Host 侧
     * `readOption(config, 'preferLocalRelay', true) !== false` 的「只有显式关闭才算关」
     * 语义对齐：未配置时开关应显示为开启（默认值）。
     *
     * @param {string} field - 配置字段名。
     * @returns {any} 字段规格。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' })
      };
    }
    // #endregion

    // #region 插件
    /**
     * 硬依赖。
     *
     * `connection` 是服务器管理按钮的通道；`configForms` 给命名空间作用域；
     * `slots` / `locale` 用于注册页面；`remote` 虽然本页没有直接用，但 `plugins.item`
     * 的槽位环境里其它卡片会用到它 —— 保留下来的好处是页面与官方设置页共享同一套
     * 远端上下文（去掉它不影响本页，但会缩短可用的注入面，出问题时更难对齐）。
     */
    const inject = ['slots', 'locale', 'remote', 'configForms', 'connection'];

    /**
     * 在 Host 提供 `dsh-ssh` 命名空间期间挂载设置页。
     *
     * `whileServed` 是守卫：没装 Host 半的部署上不会留下任何痕迹（也不会因为
     * `configForms.get()` 拿到空作用域而崩）。
     *
     * @param {any} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ssh: 词典');

      const card = new SshCardController(ctx.configForms.get(SETTINGS_NS), ctx, t);
      ctx.effect(
        () => () => {
          card.dispose();
        },
        'dsh-ssh: 设置页状态'
      );

      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: SLOT_ID,
                  order: SLOT_ORDER,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                SshCard
              )
            )
          ),
        'dsh-ssh: 设置页'
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.RPC_CHANNEL = RPC_CHANNEL;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
