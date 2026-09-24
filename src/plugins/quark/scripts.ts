/**
 * 夸克插件的注入脚本(字符串,主世界执行)。
 *
 * 只有 `EXTRACT_JS` 一个:`ctx.pages.execute` 调,读**当前目录的文件列表**(React fiber 里的 props)。
 * 不往页面里写任何东西、不注册常驻监听 —— 页面零痕迹。
 *
 * 为什么读 React fiber 而不是爬 DOM:夸克的列表项没有稳定类名,
 * 但列表组件的 props 里有结构化的 `{fid, file_name, size, file, ...}`,还顺带能读到 `selectedRowKeys`。
 * 详见 `.pi/plans/2026-09-24-quark-plugin/plan.md` §1.3。
 *
 * 约定(与 `element-fullscreen/scripts.ts` 一致):脚本内不用反引号与 `${` 插值;
 * 需要内联的参数一律走 `JSON.stringify`。
 */

/**
 * 沿 React fiber 向上找「带 `list` 数组的 props」的那个组件。
 *
 * ⚠️ 以**源码字符串**形式存在:既内联进 `EXTRACT_JS`(页面里跑),又被单测直接
 * `new Function('return ' + WALK_FN_SRC)()` 取出来喂假 fiber 对象 —— 一份实现,两处使用,
 * 不会漂移。纯函数,不碰 DOM。
 */
export const WALK_FN_SRC = String.raw`function bowQuarkWalk(fiber) {
  var node = fiber;
  var depth = 0;
  while (node && depth < 300) {
    depth++;
    var props = null;
    if (node.stateNode && node.stateNode.props) props = node.stateNode.props;
    else if (node.memoizedProps) props = node.memoizedProps;
    if (props && Object.prototype.toString.call(props.list) === '[object Array]') {
      return { props: props, depth: depth };
    }
    node = node.return;
  }
  return null;
}`

/** 找文件列表容器的候选选择器(类名可能带 hash 后缀,所以用 `*=` 兜底) */
const CONTAINER_SELECTORS = ['[class*="file-list"]', '.file-list', '[class*="FileList"]', '[class*="file_list"]']

/**
 * 读当前目录的文件列表。
 *
 * 返回 `{ ok:true, url, folderName, files:[{fid,name,size,isFile,updatedAt?}], selected, diagnostics }`,
 * 或 `{ ok:false, error, diagnostics }`。**绝不修改页面**,失败也一定带 `diagnostics`
 * (命中的选择器 / fiber 键前缀 / props 键名 / 走到哪一步) —— 页面结构一变,靠它定位。
 */
export const EXTRACT_JS: string =
  String.raw`(function () {
  'use strict';
  var diag = { selector: '', classList: '', fiberKeyPrefix: '', listLength: 0, propKeys: [], stage: 'start' };
  function fail(error) { return { ok: false, error: error, diagnostics: diag }; }
  try {
    var CANDIDATES = ` +
  JSON.stringify(CONTAINER_SELECTORS) +
  String.raw`;
    var container = null;
    for (var i = 0; i < CANDIDATES.length; i++) {
      var hit = document.querySelector(CANDIDATES[i]);
      if (hit) { container = hit; diag.selector = CANDIDATES[i]; break; }
    }
    diag.stage = 'container';
    if (!container) return fail('没找到文件列表容器(页面结构可能变了)');
    diag.classList = String(container.className || '').slice(0, 300);

    diag.stage = 'fiber-key';
    var keys = Object.keys(container);
    var fiberKey = null;
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].indexOf('__reactFiber$') === 0 || keys[k].indexOf('__reactInternalInstance$') === 0) {
        fiberKey = keys[k];
        break;
      }
    }
    if (!fiberKey) return fail('列表容器上没有 React fiber 键(页面可能不再用 React 渲染)');
    diag.fiberKeyPrefix = fiberKey.replace(/[0-9a-zA-Z]+$/, '');

    diag.stage = 'walk';
    var found = ` +
  WALK_FN_SRC +
  String.raw`(container[fiberKey]);
    if (!found) return fail('在 React 组件链上没找到带 list 属性的 props');
    var props = found.props;
    try { diag.propKeys = Object.keys(props).slice(0, 50); } catch (e) { diag.propKeys = []; }

    diag.stage = 'map';
    var list = props.list || [];
    diag.listLength = list.length;
    var files = [];
    for (var j = 0; j < list.length; j++) {
      var v = list[j] || {};
      if (!v.fid) continue;
      var isFile;
      if (typeof v.file === 'boolean') isFile = v.file;
      else if (typeof v.dir === 'boolean') isFile = !v.dir;
      else if (typeof v.file_type === 'number') isFile = v.file_type !== 0;
      else isFile = true;
      var name = v.file_name || v.name || v.title || String(v.fid);
      var size = typeof v.size === 'number' ? v.size : 0;
      var updated = typeof v.updated_at === 'number' ? v.updated_at : (typeof v.updatedAt === 'number' ? v.updatedAt : undefined);
      var item = { fid: String(v.fid), name: String(name), size: size, isFile: isFile };
      if (updated !== undefined) item.updatedAt = updated;
      files.push(item);
    }

    diag.stage = 'done';
    var selected = [];
    if (Object.prototype.toString.call(props.selectedRowKeys) === '[object Array]') {
      for (var s = 0; s < props.selectedRowKeys.length; s++) {
        if (typeof props.selectedRowKeys[s] === 'string') selected.push(props.selectedRowKeys[s]);
      }
    }
    var folderName = props.dir_name || props.dirName || props.folder_name || '';
    return {
      ok: true,
      url: String(location.href),
      folderName: String(folderName || ''),
      files: files,
      selected: selected,
      diagnostics: diag
    };
  } catch (e) {
    return fail('读取页面文件列表时出错:' + (e && e.message ? e.message : String(e)));
  }
})()`
