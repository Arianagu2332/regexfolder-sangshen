/*
 * 正则分组管理器
 *
 * 纯浏览器端 SillyTavern UI 扩展：不修改正则数据本身，只在原生正则行外增加
 * 分类折叠、文件夹分组和文件夹批量启停。正则面板 DOM 属于宿主实现细节，
 * 因此这里使用小范围运行时探测，未识别到面板时保持静默。
 */

const EXTENSION_ID = 'regex-group-manager';
const VERSION = 3;
const CATEGORIES = ['global', 'preset', 'local'];
const CATEGORY_TITLES = {
    global: ['全局正则脚本', '全局正则'],
    preset: ['预设正则脚本', '预设正则'],
    local: ['局部正则脚本', '局部正则'],
};
const SECTION_ROOT_IDS = {
    global: 'saved_regex_scripts',
    preset: 'saved_preset_scripts',
    local: 'saved_scoped_scripts',
};

const runtime = {
    sections: new Map(),
    observer: null,
    refreshTimer: null,
    refreshing: false,
};

function log(...args) { console.info(`[${EXTENSION_ID}]`, ...args); }
function warn(...args) { console.warn(`[${EXTENSION_ID}]`, ...args); }
function getHostContext() { return globalThis.SillyTavern?.getContext?.() || null; }

function extensionSettings() {
    const context = getHostContext();
    if (!context) return null;
    context.extensionSettings ??= {};
    context.extensionSettings[EXTENSION_ID] ??= {};
    return context.extensionSettings[EXTENSION_ID];
}

function saveSettings() {
    const context = getHostContext();
    if (typeof context?.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    else if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
    else warn('未找到 saveSettingsDebounced，分组变更可能不会持久化。');
}

function newId(prefix = 'rgs') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16);
}

function defaultState() {
    return {
        version: VERSION,
        collapsed: { global: true, preset: true, local: true },
        groups: { global: [], preset: [], local: [] },
        assignments: {},
    };
}

function normalizeState(raw) {
    const state = defaultState();
    if (!raw || typeof raw !== 'object') return state;
    state.collapsed = { ...state.collapsed, ...(raw.collapsed || {}) };
    state.assignments = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
    for (const category of CATEGORIES) {
        state.groups[category] = Array.isArray(raw.groups?.[category])
            ? raw.groups[category]
                .filter(group => group && typeof group.id === 'string' && typeof group.name === 'string')
                .map(group => ({ id: group.id, name: group.name, collapsed: Boolean(group.collapsed) }))
            : [];
    }
    return state;
}

function readState() { return normalizeState(extensionSettings()?.state); }

function writeState(state) {
    const settings = extensionSettings();
    if (!settings) return;
    settings.state = normalizeState(state);
    saveSettings();
}

function textOf(element) { return (element?.textContent || '').replace(/\s+/g, ' ').trim(); }

function matchesTitle(text, titles) {
    return titles.some(title => text === title || text.startsWith(`${title} `) || text.includes(title));
}

function findHeading(category) {
    const titles = CATEGORY_TITLES[category];
    const candidates = [];
    const nodes = document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,summary,div,span,label,p');
    for (const node of nodes) {
        if (node.closest('.rgs-controls,.rgs-managed-list,.rgs-group')) continue;
        if (node.matches('button,[role="button"],.menu_button,[id^="open_"]')) continue;
        const text = textOf(node);
        if (text.length > 80) continue;
        if (titles.some(title => text === title)) return node;
        if (titles.some(title => text.startsWith(`${title}：`) || text.startsWith(`${title}:`))) candidates.push(node);
    }
    return candidates[0] || null;
}

function walkParents(node, limit = 8) {
    const parents = [];
    let current = node;
    for (let index = 0; current && index < limit; index += 1, current = current.parentElement) parents.push(current);
    return parents;
}

function looksLikeRow(element) {
    if (!element || element === document.body) return false;
    if (element.classList?.contains('rgs-managed-list')
        || element.classList?.contains('rgs-group')
        || element.classList?.contains('rgs-group-header')
        || element.classList?.contains('rgs-controls')
        || element.classList?.contains('rgs-row-tools')) return false;
    if (element.dataset?.rgsNativeRow === 'true') return true;

    const text = textOf(element);
    if (!text || text.length > 300) return false;
    const controls = [...element.querySelectorAll('button,input,[role="button"]')];
    if (controls.length < 2) return false;
    const descriptors = controls.map(control => `${control.title} ${control.ariaLabel} ${control.className} ${control.dataset?.action || ''}`);
    const result = descriptors.some(value => /edit|pencil|编辑|修改|delete|trash|删除|toggle|enable|disable|启用|禁用|开关/i.test(value))
        || Boolean(element.querySelector('input[type="checkbox"]'))
        || controls.length >= 3;
    if (result) element.dataset.rgsNativeRow = 'true';
    return result;
}

function discoverRows(sectionRoot, heading) {
    const candidates = [];
    const seen = new Set();
    for (const control of sectionRoot.querySelectorAll('button,input,[role="button"]')) {
        let row = control;
        for (let depth = 0; row && depth < 8; depth += 1, row = row.parentElement) {
            if (row === sectionRoot || row === heading) break;
            if (looksLikeRow(row)) {
                if (!seen.has(row)) { seen.add(row); candidates.push(row); }
                break;
            }
        }
    }
    return candidates;
}

function findSectionRoot(category, heading) {
    const knownRoot = document.getElementById(SECTION_ROOT_IDS[category]);
    if (knownRoot) return knownRoot;
    const headingText = textOf(heading);
    for (const parent of walkParents(heading)) {
        if (parent.querySelectorAll('button,input,[role="button"]').length >= 2 && textOf(parent).includes(headingText)) {
            return parent;
        }
    }
    return heading.parentElement || heading;
}

function rowSignature(row) {
    const clone = row.cloneNode(true);
    clone.querySelectorAll('.rgs-row-tools,button,input,select,textarea').forEach(node => node.remove());
    return textOf(clone);
}

function rowKey(row, category) {
    const stable = row.dataset?.id
        || row.dataset?.regexId
        || row.getAttribute?.('data-uid')
        || row.id;

    // 宿主重绘或切换聊天时，正则行的列表序号可能改变；不能把 index 放进键里。
    if (stable) return `${category}:${stable}`;
    return `${category}:signature:${hash(rowSignature(row))}`;
}

function findLegacyAssignment(state, category, row, usedLegacyKeys) {
    const prefix = `${category}:${hash(rowSignature(row))}:`;
    const legacyKey = Object.keys(state.assignments)
        .find(key => key.startsWith(prefix) && !usedLegacyKeys.has(key));
    if (!legacyKey) return null;
    usedLegacyKeys.add(legacyKey);
    return { key: legacyKey, assignment: state.assignments[legacyKey] };
}

function getNativeToggle(row) {
    const disabledCheckbox = row.querySelector('input.disable_regex');
    if (disabledCheckbox && !disabledCheckbox.closest('.rgs-row-tools')) return disabledCheckbox;

    const controls = [...row.querySelectorAll('button,input,[role="button"]')]
        .filter(control => !control.closest('.rgs-row-tools'));
    const checkbox = controls.find(control => control.matches(
        'input[type="checkbox"]:not(.regex_bulk_checkbox):not([name="regex_expand"])',
    ));
    if (checkbox) return checkbox;
    return controls.find(control => /toggle|enable|disable|启用|禁用|开关/i.test(
        `${control.title} ${control.ariaLabel} ${control.className} ${control.dataset?.action || ""}`,
    )) || null;
}

function readEnabled(control) {
    if (!control) return null;
    if (control.matches?.('input.disable_regex')) return !Boolean(control.checked);
    if (control.matches?.('input[type="checkbox"]')) return Boolean(control.checked);
    if (control.hasAttribute?.('aria-pressed')) return control.getAttribute('aria-pressed') === 'true';
    const descriptor = `${control.className} ${control.title} ${control.ariaLabel}`;
    if (/disabled|inactive|off|禁用|关闭/i.test(descriptor)) return false;
    if (/enabled|active|on|启用|开启/i.test(descriptor)) return true;
    return null;
}

function dispatchNativeInput(control) {
    control.dispatchEvent(new Event('input', { bubbles: true }));
}

function setEnabled(row, enabled) {
    const control = getNativeToggle(row);
    if (!control) return false;

    if (control.matches?.('input.disable_regex')) {
        const shouldBeDisabled = !enabled;
        if (control.checked === shouldBeDisabled) return true;
        control.checked = shouldBeDisabled;
        dispatchNativeInput(control);
        return true;
    }

    if (control.matches?.('input[type="checkbox"]')) {
        if (control.checked === enabled) return true;
        control.checked = enabled;
        dispatchNativeInput(control);
        return true;
    }

    const current = readEnabled(control);
    if (current === null || current !== enabled) control.click();
    return true;
}

function createSwitch(checked, title, handler) {
    const label = document.createElement('label');
    label.className = 'rgs-switch';
    label.title = title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.setAttribute('aria-label', title);
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('change', event => {
        event.stopPropagation();
        handler(Boolean(input.checked));
    });

    const track = document.createElement('span');
    track.className = 'rgs-switch-track';
    track.setAttribute('aria-hidden', 'true');
    label.append(input, track);
    return label;
}

function createButton(label, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.className = 'menu_button rgs-button';
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        handler(event);
    });
    return button;
}

function ensureStyles() {
    if (document.getElementById('rgs-style-ready')) return;
    const style = document.createElement('style');
    style.id = 'rgs-style-ready';
    style.textContent = `
      .rgs-controls { display:flex; align-items:center; gap:.35rem; margin:.25rem 0 .4rem; flex-wrap:wrap; }
      .rgs-controls .rgs-button, .rgs-group-header .rgs-button { min-width:2rem; padding:.15rem .4rem; }
      .rgs-switch { display:inline-flex; align-items:center; position:relative; cursor:pointer; margin:0 .15rem; }
      .rgs-switch input { position:absolute; width:1px; height:1px; opacity:0; pointer-events:none; }
      .rgs-switch-track { position:relative; display:inline-block; width:2.2rem; height:1.2rem; border-radius:999px; background:#999; transition:background .15s ease; }
      .rgs-switch-track::after { content:""; position:absolute; top:.15rem; left:.15rem; width:.9rem; height:.9rem; border-radius:50%; background:#fff; box-shadow:0 1px 2px #0006; transition:transform .15s ease; }
      .rgs-switch input:checked + .rgs-switch-track { background:#3b82f6; }
      .rgs-switch input:checked + .rgs-switch-track::after { transform:translateX(1rem); }
      .rgs-switch input:focus-visible + .rgs-switch-track { outline:2px solid currentColor; outline-offset:2px; }
      .rgs-section-hidden .rgs-managed-list { display:none !important; }
      .rgs-section-hidden .rgs-controls { opacity:.85; }
      .rgs-managed-list { display:flex; flex-direction:column; gap:.2rem; }
      .rgs-group { border:1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius:.35rem; margin:.25rem 0; overflow:hidden; }
      .rgs-group-header { display:flex; align-items:center; gap:.35rem; padding:.2rem .35rem; background:color-mix(in srgb, currentColor 8%, transparent); }
      .rgs-group-title { flex:1; font-weight:600; }
      .rgs-group-items { display:flex; flex-direction:column; gap:.15rem; padding:.15rem; }
      .rgs-group-collapsed > .rgs-group-items { display:none; }
      .rgs-row-tools { display:inline-flex; align-items:center; gap:.15rem; margin-right:.3rem; }
      .rgs-row-tools select { max-width:9rem; min-width:4rem; font-size:.85em; }
      .rgs-empty { opacity:.65; padding:.35rem; font-size:.9em; }
    `;
    document.head.appendChild(style);
}

function addRowTools(row, category, key, groups, state, assignment = state.assignments[key]) {
    let tools = row.querySelector(':scope > .rgs-row-tools');
    if (!tools) {
        tools = document.createElement('span');
        tools.className = 'rgs-row-tools';
        row.insertBefore(tools, row.firstChild);
    }
    tools.replaceChildren();
    const select = document.createElement('select');
    select.title = '选择正则文件夹';
    select.setAttribute('aria-label', '选择正则文件夹');
    const ungrouped = document.createElement('option');
    ungrouped.value = '';
    ungrouped.textContent = '未分组';
    select.appendChild(ungrouped);
    for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = `◆ ${group.name}`;
        select.appendChild(option);
    }
    select.value = assignment?.groupId || '';
    select.addEventListener('change', () => {
        if (select.value) state.assignments[key] = { category, groupId: select.value };
        else delete state.assignments[key];
        writeState(state);
        scheduleRefresh();
    });
    tools.appendChild(select);
}

function allEnabled(rows) {
    const states = rows.map(row => readEnabled(getNativeToggle(row))).filter(value => value !== null);
    return states.length > 0 && states.every(Boolean);
}

function renderSection(category, heading, state) {
    const sectionRoot = findSectionRoot(category, heading);
    const rows = discoverRows(sectionRoot, heading);
    if (!rows.length) return null;

    let host = sectionRoot.querySelector(':scope > .rgs-managed-list');
    if (!host) {
        host = document.createElement('div');
        host.className = 'rgs-managed-list';
        host.dataset.category = category;
        sectionRoot.appendChild(host);
    }

    const groups = state.groups[category] || [];
    const rowEntries = rows.map(row => ({ key: rowKey(row, category), row }));
    const grouped = new Map(groups.map(group => [group.id, []]));
    const ungrouped = [];
    const usedLegacyKeys = new Set();
    let migratedLegacyAssignment = false;

    for (const { key, row } of rowEntries) {
        let assignment = state.assignments[key];
        if (!assignment) {
            const legacy = findLegacyAssignment(state, category, row, usedLegacyKeys);
            if (legacy) {
                assignment = legacy.assignment;
                state.assignments[key] = assignment;
                delete state.assignments[legacy.key];
                migratedLegacyAssignment = true;
            }
        }
        if (assignment?.category === category && grouped.has(assignment.groupId)) grouped.get(assignment.groupId).push([key, row]);
        else ungrouped.push([key, row]);
    }

    if (migratedLegacyAssignment) writeState(state);

    const groupEntries = [
        ...groups.map(group => [group, grouped.get(group.id) || []]),
        [{ id: '', name: '未分组', collapsed: false }, ungrouped],
    ];

    host.replaceChildren();
    for (const [group, entries] of groupEntries) {
        const wrapper = document.createElement('section');
        wrapper.className = `rgs-group${group.collapsed ? ' rgs-group-collapsed' : ''}`;
        wrapper.dataset.groupId = group.id;

        const header = document.createElement('div');
        header.className = 'rgs-group-header';
        const title = document.createElement('span');
        title.className = 'rgs-group-title';
        title.textContent = `◆ ${group.name} (${entries.length})`;
        header.appendChild(title);

        if (group.id) {
            header.appendChild(createButton(group.collapsed ? '▸' : '▾', '折叠或展开文件夹', () => {
                group.collapsed = !group.collapsed;
                writeState(state);
                scheduleRefresh();
            }));
            const groupRows = entries.map(([, row]) => row);
            header.appendChild(createSwitch(allEnabled(groupRows), '一键切换此文件夹中的正则', enabled => {
                groupRows.forEach(row => setEnabled(row, enabled));
                setTimeout(scheduleRefresh, 100);
            }));
            header.appendChild(createButton('改名', '重命名文件夹', () => {
                const name = prompt('请输入新的文件夹名称', group.name);
                if (!name?.trim()) return;
                group.name = name.trim();
                writeState(state);
                scheduleRefresh();
            }));
            header.appendChild(createButton('删', '删除文件夹（条目回到未分组）', () => {
                state.groups[category] = groups.filter(item => item.id !== group.id);
                Object.keys(state.assignments).forEach(key => {
                    if (state.assignments[key]?.groupId === group.id) delete state.assignments[key];
                });
                writeState(state);
                scheduleRefresh();
            }));
        }

        wrapper.appendChild(header);
        const items = document.createElement('div');
        items.className = 'rgs-group-items';
        for (const [key, row] of entries) {
            addRowTools(row, category, key, groups, state, state.assignments[key]);
            items.appendChild(row);
        }
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'rgs-empty';
            empty.textContent = '此文件夹暂无正则';
            items.appendChild(empty);
        }
        wrapper.appendChild(items);
        host.appendChild(wrapper);
    }

    sectionRoot.classList.toggle('rgs-section-hidden', Boolean(state.collapsed[category]));
    return { category, heading, sectionRoot, host };
}

function ensureSectionControls(category, heading, state) {
    const parent = heading.parentElement || heading;
    let controls = parent.querySelector(':scope > .rgs-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'rgs-controls';
        heading.insertAdjacentElement('afterend', controls);
    }
    controls.replaceChildren();
    controls.appendChild(createButton(state.collapsed[category] ? '展开' : '折叠', '折叠或展开此类正则', () => {
        state.collapsed[category] = !state.collapsed[category];
        writeState(state);
        scheduleRefresh();
    }));
    controls.appendChild(createButton('新建文件夹', '在此类正则下创建文件夹', () => {
        const name = prompt('请输入文件夹名称');
        if (!name?.trim()) return;
        state.groups[category].push({ id: newId('group'), name: name.trim(), collapsed: false });
        writeState(state);
        scheduleRefresh();
    }));
    controls.appendChild(createButton('全开/全关', '切换此类中所有正则', () => {
        const section = runtime.sections.get(category);
        if (!section) return;
        const rows = discoverRows(section.sectionRoot, heading);
        const target = !allEnabled(rows);
        rows.forEach(row => setEnabled(row, target));
        scheduleRefresh();
    }));
}

function refresh() {
    runtime.refreshTimer = null;
    if (!document.body || runtime.refreshing) return;
    runtime.refreshing = true;
    try {
        ensureStyles();
        const state = readState();
        const found = new Map();
        for (const category of CATEGORIES) {
            const heading = findHeading(category);
            if (!heading) continue;
            ensureSectionControls(category, heading, state);
            const section = renderSection(category, heading, state);
            if (section) found.set(category, section);
        }
        runtime.sections = found;
        if (found.size) log(`已识别 ${found.size} 个正则分类。`);
    } finally {
        runtime.refreshing = false;
    }
}

function scheduleRefresh() {
    if (!runtime.refreshTimer) runtime.refreshTimer = setTimeout(refresh, 80);
}

function startObserver() {
    if (runtime.observer || !document.body) return;
    runtime.observer = new MutationObserver(records => {
        if (runtime.refreshing) return;
        const relevant = records.some(record => {
            const target = record.target instanceof Element ? record.target : null;
            if (target?.closest('.rgs-managed-list,.rgs-controls,.rgs-row-tools')) return false;
            const nodes = [...record.addedNodes, ...record.removedNodes];
            return nodes.some(node => node instanceof Element && !node.closest('.rgs-managed-list,.rgs-controls,.rgs-row-tools'));
        });
        if (relevant) scheduleRefresh();
    });
    runtime.observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
    runtime.observer?.disconnect();
    runtime.observer = null;
    runtime.sections.clear();
}

export function clean() {
    stopObserver();
    if (runtime.refreshTimer) clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = null;

    // 清理扩展时先把原生正则行移回宿主容器，避免 clean hook 删除用户的正则行。
    document.querySelectorAll('.rgs-managed-list').forEach(host => {
        const sectionRoot = host.parentElement;
        host.querySelectorAll('[data-rgs-native-row="true"]').forEach(row => {
            row.querySelector(':scope > .rgs-row-tools')?.remove();
            if (sectionRoot) sectionRoot.insertBefore(row, host);
        });
        host.remove();
    });
    document.querySelectorAll('.rgs-controls').forEach(node => node.remove());
    document.querySelectorAll('.rgs-section-hidden').forEach(node => node.classList.remove('rgs-section-hidden'));
    document.querySelectorAll('[data-rgs-native-row="true"]').forEach(node => delete node.dataset.rgsNativeRow);
    document.getElementById('rgs-style-ready')?.remove();
}

function init() {
    if (!globalThis.SillyTavern?.getContext) {
        warn('未找到 SillyTavern.getContext，扩展未启动。');
        return;
    }
    extensionSettings();
    startObserver();
    refresh();
    log('扩展已加载。');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
