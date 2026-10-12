import { pythonEntryPoints } from "./entry-points";

interface PythonGlobals {
  set(name: string, value: unknown): void;
  destroy(): void;
}
export interface PythonRuntime {
  runPython(code: string, options?: { globals: PythonGlobals }): unknown;
}

/** 清理用的对象与函数保存在局部变量中，用户修改 builtins 后仍能恢复。 */
export const PYTHON_CASE_HARNESS = `
def _run_case():
    import builtins, json, sys
    _builtins = builtins.__dict__
    _saved_builtins = _builtins.copy()
    _modules = sys.modules
    _saved_modules = _modules.copy()
    _get_limit, _set_limit = sys.getrecursionlimit, sys.setrecursionlimit
    _limit = _get_limit()
    _tuple, _callable, _getattr, _exec = tuple, callable, getattr, exec
    _base_error, _runtime_error, _value_error = BaseException, RuntimeError, ValueError
    _loads, _dumps = json.loads, json.dumps
    def _restore():
        try:
            for _name in _tuple(_builtins):
                if _name not in _saved_builtins:
                    del _builtins[_name]
            for _name, _value in _saved_builtins.items():
                if _name not in _builtins or _builtins[_name] is not _value:
                    _builtins[_name] = _value
            sys.getrecursionlimit, sys.setrecursionlimit = _get_limit, _set_limit
            _set_limit(_limit)
            if _get_limit() != _limit:
                raise _runtime_error('递归上限未恢复')
            sys.modules = _modules
            for _name in _tuple(_modules):
                if _name not in _saved_modules:
                    del _modules[_name]
            for _name, _module in _saved_modules.items():
                _modules[_name] = _module
        except _base_error:
            raise _runtime_error('Python 运行状态清理失败，执行环境将被替换') from None
    try:
        _args = _loads(__args_json)
        _names = _loads(__names_json)
        _namespace = {'__name__': '__main__', '__builtins__': _builtins}
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
        # 序列化依赖标准 builtins；自定义返回对象的迭代也可能再次污染状态。
        _restore()
        return _dumps(_actual, ensure_ascii=False, allow_nan=False)
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
    return JSON.parse(pyodide.runPython(PYTHON_CASE_HARNESS, { globals }) as string);
  } finally { globals.destroy(); }
}
