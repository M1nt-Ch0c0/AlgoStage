import { pythonEntryPoints } from "./entry-points";

interface PythonGlobals {
  set(name: string, value: unknown): void;
  destroy(): void;
}
export interface PythonRuntime {
  runPython(code: string, options?: { globals: PythonGlobals }): unknown;
}

/** 只有 harness 完成清理后返回的用户异常，才携带复用许可。 */
export class PythonUserCodeError extends Error {
  constructor(message: string, readonly reusable: boolean) {
    super(message);
    this.name = "PythonError";
  }
}

/** 清理用的对象与函数保存在局部变量中，用户修改 builtins 后仍能恢复。 */
export const PYTHON_CASE_HARNESS = `
def _run_case():
    import builtins, json, sys, traceback
    _builtins = builtins.__dict__
    _modules = sys.modules
    _saved_modules = _modules.copy()
    _get_limit, _set_limit = sys.getrecursionlimit, sys.setrecursionlimit
    _limit = _get_limit()
    _tuple, _callable, _getattr, _exec = tuple, callable, getattr, exec
    _id, _type, _len = id, type, len
    _module_type = _type(sys)
    _module_dict = _module_type.__getattribute__
    _base_error, _runtime_error, _value_error = BaseException, RuntimeError, ValueError
    _isinstance, _fatal_errors = isinstance, (RecursionError, MemoryError)
    _loads, _dumps = json.loads, json.dumps
    _format_exception = traceback.format_exception
    def _snapshot(_namespace):
        # 同时保留原对象和 id：只恢复浅层属性绑定，不复制模块内可变对象。
        return {_key: (_value, _id(_value)) for _key, _value in _namespace.items()}
    _saved_builtins = _snapshot(_builtins)
    _saved_namespaces = {}
    for _module in _saved_modules.values():
        if isinstance(_module, _module_type):
            _namespace = _module_dict(_module, '__dict__')
            _saved_namespaces[_id(_module)] = (_module, _type(_module), _namespace, _snapshot(_namespace))
    def _restore_dict(_namespace, _saved):
        for _key in _tuple(_namespace):
            if _key not in _saved:
                del _namespace[_key]
        for _key, (_value, _value_id) in _saved.items():
            if _key not in _namespace or _id(_namespace[_key]) != _value_id:
                _namespace[_key] = _value
    def _restore():
        try:
            _restore_dict(_builtins, _saved_builtins)
            for _module, _module_class, _namespace, _saved in _saved_namespaces.values():
                if _type(_module) is not _module_class or _module_dict(_module, '__dict__') is not _namespace:
                    raise _runtime_error('模块类型或命名空间被替换')
                _restore_dict(_namespace, _saved)
            _set_limit(_limit)
            if _get_limit() != _limit:
                raise _runtime_error('递归上限未恢复')
            for _name in _tuple(_modules):
                if _name not in _saved_modules:
                    del _modules[_name]
            for _name, _module in _saved_modules.items():
                _modules[_name] = _module
            # 完成全部恢复后再核验，任何无法可靠恢复的状态都令 worker 作废。
            if _len(_modules) != _len(_saved_modules):
                raise _runtime_error('模块映射未恢复')
            for _name, _module in _saved_modules.items():
                if _name not in _modules or _modules[_name] is not _module:
                    raise _runtime_error('模块映射未恢复')
            for _module, _module_class, _namespace, _saved in _saved_namespaces.values():
                if _type(_module) is not _module_class or _module_dict(_module, '__dict__') is not _namespace or _len(_namespace) != _len(_saved):
                    raise _runtime_error('模块命名空间未恢复')
                for _key, (_value, _value_id) in _saved.items():
                    if _key not in _namespace or _id(_namespace[_key]) != _value_id:
                        raise _runtime_error('模块属性未恢复')
        except _base_error:
            raise _runtime_error('Python 运行状态清理失败，执行环境将被替换') from None
    def _user_failure(_error):
        _error_str = ''.join(_format_exception(_error))
        _reusable = not _isinstance(_error, _fatal_errors)
        _restore()
        return _dumps({'error': _error_str, 'reusable': _reusable}, ensure_ascii=False)
    try:
        _args = _loads(__args_json)
        _names = _loads(__names_json)
        _namespace = {'__name__': '__main__', '__builtins__': _builtins}
        try:
            _exec(__source, _namespace)
            _fn = None
            for _name in _names:
                if _callable(_namespace.get(_name)):
                    _fn = _namespace[_name]
                    break
            if _fn is None and _callable(_namespace.get('Solution')):
                _solution = _namespace['Solution']()
                for _name in _names:
                    _candidate = _getattr(_solution, _name, None)
                    if _callable(_candidate):
                        _fn = _candidate
                        break
            if _fn is None:
                raise _value_error('没有找到题目入口函数')
            _returned = _fn(*_args)
            _actual = _args[__mutates] if __mutates >= 0 else _returned
        except _base_error as _error:
            return _user_failure(_error)
        # 序列化依赖标准 builtins；自定义返回对象的迭代也可能再次污染状态。
        _restore()
        try:
            return _dumps({'actual': _actual}, ensure_ascii=False, allow_nan=False)
        except _base_error as _error:
            return _user_failure(_error)
    finally:
        _restore()
_run_case()
`;

export function runPythonCase(pyodide: PythonRuntime, code: string, args: unknown[], names: string[], mutatesArg = -1): unknown {
  // 包装器也使用新 dict，既不把用户全局变量留在 Pyodide 主命名空间，
  // 也不保留上一个用例的函数、参数或返回值。保持原有逐用例隔离行为。
  const globals = pyodide.runPython("dict()") as PythonGlobals;
  try {
    globals.set("__source", code);
    globals.set("__args_json", JSON.stringify(args));
    globals.set("__names_json", JSON.stringify(pythonEntryPoints(names)));
    globals.set("__mutates", mutatesArg);
    const result = JSON.parse(pyodide.runPython(PYTHON_CASE_HARNESS, { globals }) as string) as { actual: unknown } | { error: string; reusable: boolean };
    if ("error" in result) throw new PythonUserCodeError(result.error, result.reusable);
    return result.actual;
  } finally { globals.destroy(); }
}
