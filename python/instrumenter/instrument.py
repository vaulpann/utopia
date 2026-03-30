#!/usr/bin/env python3
"""
Utopia Python AST Instrumenter

Instruments Python source files by injecting observability probes via AST
transformation. Supports error, database, API, and infrastructure probes.

Usage:
    python instrument.py instrument <file_path> [options]
    python instrument.py validate <file_path> [options]

Options:
    --probe-types error,database,api,infra   Comma-separated probe types (default: all)
    --utopia-mode                            Enable function probes
    --dry-run                                Print transformed code without writing
    --output-json                            Output results as JSON
"""

import argparse
import ast
import copy
import json
import os
import sys
import textwrap
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALL_PROBE_TYPES = {"error", "database", "api", "infra"}

ENTRY_POINT_NAMES = {"main.py", "app.py", "wsgi.py", "asgi.py", "manage.py", "__main__.py"}

DB_CALL_PATTERNS: dict[str, dict[str, str]] = {
    # attr_name -> {method -> library}
    "execute": {"cursor": "dbapi", "session": "sqlalchemy", "conn": "asyncpg"},
    "executemany": {"cursor": "dbapi"},
    "query": {"session": "sqlalchemy"},
    "fetch": {"conn": "asyncpg"},
    "fetchrow": {"conn": "asyncpg"},
    "fetchval": {"conn": "asyncpg"},
    "find": {"collection": "pymongo"},
    "find_one": {"collection": "pymongo"},
    "insert_one": {"collection": "pymongo"},
    "insert_many": {"collection": "pymongo"},
    "update_one": {"collection": "pymongo"},
    "update_many": {"collection": "pymongo"},
    "delete_one": {"collection": "pymongo"},
    "delete_many": {"collection": "pymongo"},
    "replace_one": {"collection": "pymongo"},
    "aggregate": {"collection": "pymongo"},
    "count_documents": {"collection": "pymongo"},
    "filter": {"objects": "django"},
    "get": {"objects": "django"},
    "create": {"objects": "django"},
    "bulk_create": {"objects": "django"},
    "exclude": {"objects": "django"},
    "all": {"objects": "django"},
}

API_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}

API_CALLERS = {"requests", "httpx", "client", "session", "aiohttp"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_import_inline(module: str) -> ast.Call:
    """Build ``__import__('<module>')``."""
    return ast.Call(
        func=ast.Name(id="__import__", ctx=ast.Load()),
        args=[ast.Constant(value=module)],
        keywords=[],
    )


def _make_file_expr() -> ast.IfExp:
    """Build ``__file__ if '__file__' in dir() else '<unknown>'``."""
    return ast.IfExp(
        test=ast.Compare(
            left=ast.Constant(value="__file__"),
            ops=[ast.In()],
            comparators=[
                ast.Call(func=ast.Name(id="dir", ctx=ast.Load()), args=[], keywords=[])
            ],
        ),
        body=ast.Name(id="__file__", ctx=ast.Load()),
        orelse=ast.Constant(value="<unknown>"),
    )


def _attr_chain(node: ast.expr) -> list[str]:
    """Return the chain of attribute names for dotted access, e.g. ['db', 'session', 'execute']."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    parts.reverse()
    return parts


def _enclosing_function(ancestors: list[ast.AST]) -> str:
    for node in reversed(ancestors):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node.name
    return "<module>"


def _is_utopia_try(node: ast.stmt) -> bool:
    """Return True if *node* is a try block we already injected."""
    if not isinstance(node, ast.Try):
        return False
    src = ast.dump(node)
    return "utopia" in src.lower()


def _function_has_utopia_wrap(func_node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """Check whether the function body is already a single utopia try/except."""
    body = func_node.body
    # skip docstrings
    start = 0
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        start = 1
    remaining = body[start:]
    if len(remaining) == 1 and _is_utopia_try(remaining[0]):
        return True
    return False


# ---------------------------------------------------------------------------
# AST Transformer
# ---------------------------------------------------------------------------

class UtopiaTransformer(ast.NodeTransformer):
    """Walk the AST and inject probes according to *probe_types*."""

    def __init__(
        self,
        filepath: str,
        probe_types: set[str],
        utopia_mode: bool = False,
    ) -> None:
        super().__init__()
        self.filepath = filepath
        self.probe_types = probe_types
        self.utopia_mode = utopia_mode
        self.probes_added: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self._ancestor_stack: list[ast.AST] = []
        self._needs_utopia_import = False

    # -- helpers --

    def _record(self, probe_type: str, line: int, **extra: Any) -> None:
        entry: dict[str, Any] = {"type": probe_type, "line": line}
        entry.update(extra)
        self.probes_added.append(entry)
        self._needs_utopia_import = True

    def _current_function(self) -> str:
        return _enclosing_function(self._ancestor_stack)

    # -- visitor plumbing --

    def _visit_children(self, node: ast.AST) -> ast.AST:
        self._ancestor_stack.append(node)
        self.generic_visit(node)
        self._ancestor_stack.pop()
        return node

    # ------------------------------------------------------------------
    # Error probes  (wrap function bodies)
    # ------------------------------------------------------------------

    def _wrap_function_body(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.AST:
        if _function_has_utopia_wrap(node):
            return self._visit_children(node)

        original_body = node.body
        # Preserve leading docstring outside the try so tools can still find it
        docstring_stmts: list[ast.stmt] = []
        remaining_body = list(original_body)
        if (
            remaining_body
            and isinstance(remaining_body[0], ast.Expr)
            and isinstance(remaining_body[0].value, ast.Constant)
            and isinstance(remaining_body[0].value.value, str)
        ):
            docstring_stmts.append(remaining_body.pop(0))

        if not remaining_body:
            return self._visit_children(node)

        line = node.lineno

        # Build the input_data dict from function params
        param_names: list[str] = []
        for arg in node.args.args:
            if arg.arg != "self" and arg.arg != "cls":
                param_names.append(arg.arg)
        for arg in node.args.posonlyargs:
            if arg.arg != "self" and arg.arg != "cls":
                param_names.append(arg.arg)
        for arg in node.args.kwonlyargs:
            param_names.append(arg.arg)
        if node.args.vararg:
            param_names.append(node.args.vararg.arg)
        if node.args.kwarg:
            param_names.append(node.args.kwarg.arg)

        # {param: repr(param) for each param}
        input_dict_keys: list[ast.expr] = []
        input_dict_values: list[ast.expr] = []
        for p in param_names:
            input_dict_keys.append(ast.Constant(value=p))
            input_dict_values.append(
                ast.Call(
                    func=ast.Name(id="repr", ctx=ast.Load()),
                    args=[ast.Name(id=p, ctx=ast.Load())],
                    keywords=[],
                )
            )
        input_data_node = ast.Dict(keys=input_dict_keys, values=input_dict_values)

        # except block
        err_name = "__utopia_err"
        mod_alias = "__utopia_mod"
        tb_alias = "__utopia_tb"

        import_runtime = ast.Assign(
            targets=[ast.Name(id=mod_alias, ctx=ast.Store())],
            value=_make_import_inline("utopia_runtime"),
            lineno=line,
        )
        import_tb = ast.Assign(
            targets=[ast.Name(id=tb_alias, ctx=ast.Store())],
            value=_make_import_inline("traceback"),
            lineno=line,
        )
        report_call = ast.Expr(
            value=ast.Call(
                func=ast.Attribute(
                    value=ast.Name(id=mod_alias, ctx=ast.Load()),
                    attr="report_error",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[
                    ast.keyword(arg="file", value=_make_file_expr()),
                    ast.keyword(arg="line", value=ast.Constant(value=line)),
                    ast.keyword(arg="function_name", value=ast.Constant(value=node.name)),
                    ast.keyword(
                        arg="error_type",
                        value=ast.Attribute(
                            value=ast.Call(
                                func=ast.Name(id="type", ctx=ast.Load()),
                                args=[ast.Name(id=err_name, ctx=ast.Load())],
                                keywords=[],
                            ),
                            attr="__name__",
                            ctx=ast.Load(),
                        ),
                    ),
                    ast.keyword(
                        arg="message",
                        value=ast.Call(
                            func=ast.Name(id="str", ctx=ast.Load()),
                            args=[ast.Name(id=err_name, ctx=ast.Load())],
                            keywords=[],
                        ),
                    ),
                    ast.keyword(
                        arg="stack",
                        value=ast.Call(
                            func=ast.Attribute(
                                value=ast.Name(id=tb_alias, ctx=ast.Load()),
                                attr="format_exc",
                                ctx=ast.Load(),
                            ),
                            args=[],
                            keywords=[],
                        ),
                    ),
                    ast.keyword(arg="input_data", value=input_data_node),
                ],
            )
        )
        raise_stmt = ast.Raise()

        handler = ast.ExceptHandler(
            type=ast.Name(id="Exception", ctx=ast.Load()),
            name=err_name,
            body=[import_runtime, import_tb, report_call, raise_stmt],
        )

        try_node = ast.Try(
            body=remaining_body,
            handlers=[handler],
            orelse=[],
            finalbody=[],
        )

        node.body = docstring_stmts + [try_node]
        self._record("error", line, function_name=node.name)

        # Now visit the children inside the body (important for nested functions)
        return self._visit_children(node)

    # ------------------------------------------------------------------
    # Function probes  (utopia mode)
    # ------------------------------------------------------------------

    def _wrap_function_probe(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.AST:
        """Add timing + arg/return capture around entire function body."""
        line = node.lineno

        # Build param repr dict
        param_names: list[str] = []
        for arg in node.args.args + node.args.posonlyargs + node.args.kwonlyargs:
            if arg.arg not in ("self", "cls"):
                param_names.append(arg.arg)
        if node.args.vararg:
            param_names.append(node.args.vararg.arg)
        if node.args.kwarg:
            param_names.append(node.args.kwarg.arg)

        args_dict_keys = [ast.Constant(value=p) for p in param_names]
        args_dict_values = [
            ast.Call(
                func=ast.Name(id="repr", ctx=ast.Load()),
                args=[ast.Name(id=p, ctx=ast.Load())],
                keywords=[],
            )
            for p in param_names
        ]
        args_data_node = ast.Dict(keys=args_dict_keys, values=args_dict_values)

        # We wrap the body in:
        #   __utopia_fn_t0 = __import__('time').perf_counter()
        #   try:
        #       <body>
        #   finally:
        #       __utopia_fn_dur = __import__('time').perf_counter() - __utopia_fn_t0
        #       __import__('utopia_runtime').report_function(...)

        timer_start = ast.Assign(
            targets=[ast.Name(id="__utopia_fn_t0", ctx=ast.Store())],
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("time"),
                    attr="perf_counter",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[],
            ),
            lineno=line,
        )

        timer_end = ast.Assign(
            targets=[ast.Name(id="__utopia_fn_dur", ctx=ast.Store())],
            value=ast.BinOp(
                left=ast.Call(
                    func=ast.Attribute(
                        value=_make_import_inline("time"),
                        attr="perf_counter",
                        ctx=ast.Load(),
                    ),
                    args=[],
                    keywords=[],
                ),
                op=ast.Sub(),
                right=ast.Name(id="__utopia_fn_t0", ctx=ast.Load()),
            ),
            lineno=line,
        )

        report_fn_call = ast.Expr(
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("utopia_runtime"),
                    attr="report_function",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[
                    ast.keyword(arg="file", value=_make_file_expr()),
                    ast.keyword(arg="line", value=ast.Constant(value=line)),
                    ast.keyword(arg="function_name", value=ast.Constant(value=node.name)),
                    ast.keyword(arg="args", value=args_data_node),
                    ast.keyword(arg="duration", value=ast.Name(id="__utopia_fn_dur", ctx=ast.Load())),
                ],
            )
        )

        # Preserve docstring
        docstring_stmts: list[ast.stmt] = []
        remaining_body = list(node.body)
        if (
            remaining_body
            and isinstance(remaining_body[0], ast.Expr)
            and isinstance(remaining_body[0].value, ast.Constant)
            and isinstance(remaining_body[0].value.value, str)
        ):
            docstring_stmts.append(remaining_body.pop(0))

        if not remaining_body:
            return self._visit_children(node)

        try_finally = ast.Try(
            body=remaining_body,
            handlers=[],
            orelse=[],
            finalbody=[timer_end, report_fn_call],
        )

        node.body = docstring_stmts + [timer_start, try_finally]
        self._record("function", line, function_name=node.name)
        return self._visit_children(node)

    # ------------------------------------------------------------------
    # Database probes
    # ------------------------------------------------------------------

    def _is_db_call(self, node: ast.Call) -> tuple[str, str, str] | None:
        """Return (method, receiver_hint, library) if *node* is a recognised DB call, else None."""
        func = node.func
        if not isinstance(func, ast.Attribute):
            return None
        method = func.attr
        patterns = DB_CALL_PATTERNS.get(method)
        if patterns is None:
            return None

        chain = _attr_chain(func.value)
        if not chain:
            return None

        # Check for db.session.execute style (last element of chain matches key)
        for receiver, lib in patterns.items():
            if chain[-1] == receiver or (len(chain) >= 2 and chain[-1] == receiver):
                return method, receiver, lib
            # Also match if the chain contains the receiver anywhere
            if receiver in chain:
                return method, receiver, lib

        # Fallback: match any Name receiver against known patterns
        if isinstance(func.value, ast.Name) and func.value.id in patterns:
            return method, func.value.id, patterns[func.value.id]

        return None

    def _make_db_probe_stmts(
        self, node: ast.Call, method: str, receiver: str, lib: str, line: int
    ) -> list[ast.stmt]:
        """Build the timing + report statements for a DB call."""
        # first_arg repr for query
        query_node: ast.expr
        if node.args:
            query_node = ast.Call(
                func=ast.Name(id="repr", ctx=ast.Load()),
                args=[node.args[0]],
                keywords=[],
            )
        else:
            query_node = ast.Constant(value=None)

        timer_start = ast.Assign(
            targets=[ast.Name(id="__utopia_db_t0", ctx=ast.Store())],
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("time"),
                    attr="perf_counter",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[],
            ),
            lineno=line,
        )
        timer_end = ast.Assign(
            targets=[ast.Name(id="__utopia_db_dur", ctx=ast.Store())],
            value=ast.BinOp(
                left=ast.Call(
                    func=ast.Attribute(
                        value=_make_import_inline("time"),
                        attr="perf_counter",
                        ctx=ast.Load(),
                    ),
                    args=[],
                    keywords=[],
                ),
                op=ast.Sub(),
                right=ast.Name(id="__utopia_db_t0", ctx=ast.Load()),
            ),
            lineno=line,
        )
        report_call = ast.Expr(
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("utopia_runtime"),
                    attr="report_db",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[
                    ast.keyword(arg="file", value=_make_file_expr()),
                    ast.keyword(arg="line", value=ast.Constant(value=line)),
                    ast.keyword(arg="function_name", value=ast.Constant(value=self._current_function())),
                    ast.keyword(arg="operation", value=ast.Constant(value=method)),
                    ast.keyword(arg="query", value=query_node),
                    ast.keyword(arg="duration", value=ast.Name(id="__utopia_db_dur", ctx=ast.Load())),
                    ast.keyword(
                        arg="connection_info",
                        value=ast.Dict(
                            keys=[ast.Constant(value="type")],
                            values=[ast.Constant(value=lib)],
                        ),
                    ),
                ],
            )
        )
        return [timer_start], [timer_end, report_call]

    # ------------------------------------------------------------------
    # API probes
    # ------------------------------------------------------------------

    def _is_api_call(self, node: ast.Call) -> tuple[str, str] | None:
        """Return (http_method, library_hint) if *node* is a recognised HTTP call, else None."""
        func = node.func
        if not isinstance(func, ast.Attribute):
            return None
        method = func.attr.lower()
        if method not in API_METHODS:
            return None
        chain = _attr_chain(func.value)
        if not chain:
            # bare Name e.g. requests.get
            if isinstance(func.value, ast.Name) and func.value.id.lower() in API_CALLERS:
                return method, func.value.id
            return None
        # Check if any part of the chain matches known callers
        for part in chain:
            if part.lower() in API_CALLERS:
                return method, part
        return None

    def _make_api_probe_stmts(
        self, node: ast.Call, http_method: str, lib_hint: str, line: int
    ) -> tuple[list[ast.stmt], list[ast.stmt]]:
        """Build the timing + report statements for an API call."""
        url_node: ast.expr
        if node.args:
            url_node = node.args[0]
        else:
            # look for url= keyword
            url_kw = next((kw for kw in node.keywords if kw.arg == "url"), None)
            url_node = url_kw.value if url_kw else ast.Constant(value="<unknown>")

        timer_start = ast.Assign(
            targets=[ast.Name(id="__utopia_api_t0", ctx=ast.Store())],
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("time"),
                    attr="perf_counter",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[],
            ),
            lineno=line,
        )
        timer_end = ast.Assign(
            targets=[ast.Name(id="__utopia_api_dur", ctx=ast.Store())],
            value=ast.BinOp(
                left=ast.Call(
                    func=ast.Attribute(
                        value=_make_import_inline("time"),
                        attr="perf_counter",
                        ctx=ast.Load(),
                    ),
                    args=[],
                    keywords=[],
                ),
                op=ast.Sub(),
                right=ast.Name(id="__utopia_api_t0", ctx=ast.Load()),
            ),
            lineno=line,
        )

        # Try to get status_code from the result variable if assigned
        # We'll use a helper: getattr(__utopia_api_res, 'status_code', None)
        status_code_node = ast.Call(
            func=ast.Name(id="getattr", ctx=ast.Load()),
            args=[
                ast.Name(id="__utopia_api_res", ctx=ast.Load()),
                ast.Constant(value="status_code"),
                ast.Constant(value=None),
            ],
            keywords=[],
        )

        report_call = ast.Expr(
            value=ast.Call(
                func=ast.Attribute(
                    value=_make_import_inline("utopia_runtime"),
                    attr="report_api",
                    ctx=ast.Load(),
                ),
                args=[],
                keywords=[
                    ast.keyword(arg="file", value=_make_file_expr()),
                    ast.keyword(arg="line", value=ast.Constant(value=line)),
                    ast.keyword(arg="function_name", value=ast.Constant(value=self._current_function())),
                    ast.keyword(arg="method", value=ast.Constant(value=http_method.upper())),
                    ast.keyword(
                        arg="url",
                        value=ast.Call(
                            func=ast.Name(id="str", ctx=ast.Load()),
                            args=[copy.deepcopy(url_node)],
                            keywords=[],
                        ),
                    ),
                    ast.keyword(arg="status_code", value=status_code_node),
                    ast.keyword(arg="duration", value=ast.Name(id="__utopia_api_dur", ctx=ast.Load())),
                ],
            )
        )
        return [timer_start], [timer_end, report_call]

    # ------------------------------------------------------------------
    # Statement-level visitor (for DB / API probes in Assign / Expr)
    # ------------------------------------------------------------------

    def _visit_stmt_list(self, stmts: list[ast.stmt]) -> list[ast.stmt]:
        """Process a list of statements, injecting DB/API probes where needed."""
        new_stmts: list[ast.stmt] = []
        for stmt in stmts:
            injected = False

            # --- Assign: result = some_call(...) ---
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                call_node = stmt.value
                if isinstance(call_node, ast.Await):
                    call_node = call_node.value
                if isinstance(call_node, ast.Call):
                    if "database" in self.probe_types:
                        db_info = self._is_db_call(call_node)
                        if db_info:
                            method, receiver, lib = db_info
                            pre, post = self._make_db_probe_stmts(call_node, method, receiver, lib, stmt.lineno)
                            new_stmts.extend(pre)
                            new_stmts.append(stmt)
                            new_stmts.extend(post)
                            self._record("database", stmt.lineno, function_name=self._current_function(), operation=method)
                            injected = True
                    if not injected and "api" in self.probe_types:
                        api_info = self._is_api_call(call_node)
                        if api_info:
                            http_method, lib_hint = api_info
                            pre, post = self._make_api_probe_stmts(call_node, http_method, lib_hint, stmt.lineno)
                            # Rewrite: __utopia_api_res = <call>; original_target = __utopia_api_res
                            res_assign = ast.Assign(
                                targets=[ast.Name(id="__utopia_api_res", ctx=ast.Store())],
                                value=stmt.value,
                                lineno=stmt.lineno,
                            )
                            copy_assign = ast.Assign(
                                targets=stmt.targets,
                                value=ast.Name(id="__utopia_api_res", ctx=ast.Load()),
                                lineno=stmt.lineno,
                            )
                            new_stmts.extend(pre)
                            new_stmts.append(res_assign)
                            new_stmts.extend(post)
                            new_stmts.append(copy_assign)
                            self._record("api", stmt.lineno, function_name=self._current_function(), method=http_method.upper())
                            injected = True

            # --- Expr: bare call ---
            elif isinstance(stmt, ast.Expr):
                call_node = stmt.value
                if isinstance(call_node, ast.Await):
                    call_node = call_node.value
                if isinstance(call_node, ast.Call):
                    if "database" in self.probe_types:
                        db_info = self._is_db_call(call_node)
                        if db_info:
                            method, receiver, lib = db_info
                            pre, post = self._make_db_probe_stmts(call_node, method, receiver, lib, stmt.lineno)
                            new_stmts.extend(pre)
                            new_stmts.append(stmt)
                            new_stmts.extend(post)
                            self._record("database", stmt.lineno, function_name=self._current_function(), operation=method)
                            injected = True
                    if not injected and "api" in self.probe_types:
                        api_info = self._is_api_call(call_node)
                        if api_info:
                            http_method, lib_hint = api_info
                            pre, post = self._make_api_probe_stmts(call_node, http_method, lib_hint, stmt.lineno)
                            # Wrap into assignment so we can read status_code
                            res_assign = ast.Assign(
                                targets=[ast.Name(id="__utopia_api_res", ctx=ast.Store())],
                                value=stmt.value,
                                lineno=stmt.lineno,
                            )
                            new_stmts.extend(pre)
                            new_stmts.append(res_assign)
                            new_stmts.extend(post)
                            self._record("api", stmt.lineno, function_name=self._current_function(), method=http_method.upper())
                            injected = True

            if not injected:
                new_stmts.append(stmt)

        return new_stmts

    # ------------------------------------------------------------------
    # Infra probes
    # ------------------------------------------------------------------

    def _make_infra_probe(self) -> list[ast.stmt]:
        """Build the __utopia_detect_infra function + call."""
        # We build the function as a string and parse it, for readability.
        code = textwrap.dedent("""\
        def __utopia_detect_infra():
            import os
            __import__('utopia_runtime').report_infra(
                file=__file__ if '__file__' in dir() else '<unknown>',
                line=0,
                provider='aws' if os.environ.get('AWS_REGION') else 'gcp' if os.environ.get('GOOGLE_CLOUD_PROJECT') else 'vercel' if os.environ.get('VERCEL') else 'other',
                region=os.environ.get('AWS_REGION') or os.environ.get('GOOGLE_CLOUD_REGION') or os.environ.get('VERCEL_REGION'),
                env_vars={k: v for k, v in os.environ.items() if not any(s in k.upper() for s in ('KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CRED'))}
            )
        __utopia_detect_infra()
        """)
        tree = ast.parse(code)
        return tree.body  # [FunctionDef, Expr(call)]

    # ------------------------------------------------------------------
    # Top-level visit dispatcher
    # ------------------------------------------------------------------

    def visit_Module(self, node: ast.Module) -> ast.Module:
        # First, generically visit so all children are transformed
        self._ancestor_stack.append(node)

        # Visit all function defs for error / function probes
        node = self._visit_module_body(node)

        self._ancestor_stack.pop()

        # Inject infra probe for entry-point files
        if "infra" in self.probe_types:
            basename = os.path.basename(self.filepath)
            if basename in ENTRY_POINT_NAMES:
                infra_stmts = self._make_infra_probe()
                # Insert after the last import/from-import at top of module
                insert_idx = 0
                for i, stmt in enumerate(node.body):
                    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
                        insert_idx = i + 1
                for s in reversed(infra_stmts):
                    node.body.insert(insert_idx, s)
                self._record("infra", 0, function_name="<module>")

        return node

    def _visit_module_body(self, node: ast.Module) -> ast.Module:
        """Recursively visit the module, handling function wrapping and statement probes."""
        new_body: list[ast.stmt] = []
        for stmt in node.body:
            stmt = self._visit_node(stmt)
            new_body.append(stmt)
        node.body = new_body

        # Now do statement-level DB/API injection on the module body
        if "database" in self.probe_types or "api" in self.probe_types:
            node.body = self._visit_stmt_list(node.body)

        return node

    def _visit_node(self, node: ast.AST) -> ast.AST:
        """Visit a single node, dispatching to the appropriate handler."""
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return self._visit_function(node)
        elif isinstance(node, ast.ClassDef):
            return self._visit_classdef(node)
        elif isinstance(node, (ast.If, ast.For, ast.While, ast.With, ast.AsyncFor, ast.AsyncWith)):
            return self._visit_compound(node)
        elif isinstance(node, ast.Try):
            return self._visit_try(node)
        return node

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.AST:
        """Visit a function definition: recurse into body, then apply probes."""
        # First recurse into nested definitions
        new_body: list[ast.stmt] = []
        for stmt in node.body:
            stmt = self._visit_node(stmt)
            new_body.append(stmt)
        node.body = new_body

        # Inject DB/API probes at statement level inside the function
        if "database" in self.probe_types or "api" in self.probe_types:
            self._ancestor_stack.append(node)
            node.body = self._visit_stmt_list(node.body)
            self._ancestor_stack.pop()

        # Wrap with error probe
        if "error" in self.probe_types:
            node = self._wrap_function_body(node)

        # Wrap with function probe (utopia mode)
        if self.utopia_mode:
            node = self._wrap_function_probe(node)

        return node

    def _visit_classdef(self, node: ast.ClassDef) -> ast.ClassDef:
        new_body: list[ast.stmt] = []
        self._ancestor_stack.append(node)
        for stmt in node.body:
            stmt = self._visit_node(stmt)
            new_body.append(stmt)
        node.body = new_body
        if "database" in self.probe_types or "api" in self.probe_types:
            node.body = self._visit_stmt_list(node.body)
        self._ancestor_stack.pop()
        return node

    def _visit_compound(self, node: ast.AST) -> ast.AST:
        """Visit compound statements (if/for/while/with) recursively."""
        self._ancestor_stack.append(node)
        for field_name in ("body", "orelse", "finalbody"):
            body = getattr(node, field_name, None)
            if body and isinstance(body, list):
                new_body = []
                for stmt in body:
                    stmt = self._visit_node(stmt)
                    new_body.append(stmt)
                setattr(node, field_name, new_body)
                if "database" in self.probe_types or "api" in self.probe_types:
                    setattr(node, field_name, self._visit_stmt_list(getattr(node, field_name)))
        self._ancestor_stack.pop()
        return node

    def _visit_try(self, node: ast.Try) -> ast.Try:
        self._ancestor_stack.append(node)
        for field_name in ("body", "orelse", "finalbody"):
            body = getattr(node, field_name, None)
            if body and isinstance(body, list):
                new_body = []
                for stmt in body:
                    stmt = self._visit_node(stmt)
                    new_body.append(stmt)
                setattr(node, field_name, new_body)
                if "database" in self.probe_types or "api" in self.probe_types:
                    setattr(node, field_name, self._visit_stmt_list(getattr(node, field_name)))
        for handler in node.handlers:
            if handler.body:
                new_body = []
                for stmt in handler.body:
                    stmt = self._visit_node(stmt)
                    new_body.append(stmt)
                handler.body = new_body
                if "database" in self.probe_types or "api" in self.probe_types:
                    handler.body = self._visit_stmt_list(handler.body)
        self._ancestor_stack.pop()
        return node


# ---------------------------------------------------------------------------
# Top-level instrumentation logic
# ---------------------------------------------------------------------------

def _add_top_imports(tree: ast.Module) -> None:
    """Ensure ``import utopia_runtime`` is at the top of the module if needed."""
    has_utopia_import = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "utopia_runtime":
                    has_utopia_import = True
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.startswith("utopia_runtime"):
                has_utopia_import = True
    # We rely on inline __import__ calls, so a top-level import is optional
    # but nice for readability.  Only add if transformer flagged need.
    # Actually, we do NOT add top-level imports -- the injected code uses
    # __import__() for isolation and to avoid polluting the namespace.


def instrument_file(
    filepath: str,
    probe_types: set[str],
    utopia_mode: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Instrument a single Python file. Returns a result dict."""
    result: dict[str, Any] = {
        "success": False,
        "file": filepath,
        "probes_added": [],
        "errors": [],
    }

    # Read source
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as exc:
        result["errors"].append(f"Failed to read file: {exc}")
        return result

    # Parse
    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as exc:
        result["errors"].append(f"Syntax error: {exc}")
        return result

    # Transform
    try:
        transformer = UtopiaTransformer(filepath, probe_types, utopia_mode=utopia_mode)
        new_tree = transformer.visit_Module(tree)
        ast.fix_missing_locations(new_tree)
        result["probes_added"] = transformer.probes_added
        result["errors"] = transformer.errors
    except Exception as exc:
        result["errors"].append(f"Transformation error: {exc}")
        return result

    # Generate code
    try:
        new_source = ast.unparse(new_tree)
    except Exception as exc:
        result["errors"].append(f"Code generation error: {exc}")
        return result

    # Write or return
    if dry_run:
        result["code"] = new_source
    else:
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_source)
        except Exception as exc:
            result["errors"].append(f"Failed to write file: {exc}")
            return result

    result["success"] = True
    return result


def validate_file(filepath: str) -> dict[str, Any]:
    """Validate that a file has been properly instrumented."""
    result: dict[str, Any] = {
        "success": False,
        "file": filepath,
        "probes_found": [],
        "errors": [],
    }

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as exc:
        result["errors"].append(f"Failed to read file: {exc}")
        return result

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as exc:
        result["errors"].append(f"Syntax error in instrumented file: {exc}")
        return result

    # Walk the tree looking for utopia probe markers
    for node in ast.walk(tree):
        # Look for __import__('utopia_runtime') calls
        if isinstance(node, ast.Call):
            if (
                isinstance(node.func, ast.Name)
                and node.func.id == "__import__"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "utopia_runtime"
            ):
                # Find what method is being called on it
                pass

        # Look for utopia variable names
        if isinstance(node, ast.Name) and node.id.startswith("__utopia_"):
            result["probes_found"].append(
                {"type": "variable", "name": node.id, "line": getattr(node, "lineno", 0)}
            )

        # Look for try/except with utopia report calls
        if isinstance(node, ast.Try):
            for handler in node.handlers:
                if handler.name and handler.name.startswith("__utopia_"):
                    result["probes_found"].append(
                        {"type": "error_handler", "name": handler.name, "line": getattr(handler, "lineno", 0)}
                    )

        # Look for __utopia_detect_infra
        if isinstance(node, ast.FunctionDef) and node.name == "__utopia_detect_infra":
            result["probes_found"].append(
                {"type": "infra", "name": node.name, "line": getattr(node, "lineno", 0)}
            )

    # Check that the file at least compiles
    try:
        compile(source, filepath, "exec")
    except Exception as exc:
        result["errors"].append(f"Instrumented file does not compile: {exc}")
        return result

    result["success"] = True
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="instrument",
        description="Utopia Python AST Instrumenter - inject observability probes into Python source files",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # instrument
    instr_parser = subparsers.add_parser("instrument", help="Instrument a Python file")
    instr_parser.add_argument("file_path", help="Path to the Python file to instrument")
    instr_parser.add_argument(
        "--probe-types",
        default="error,database,api,infra",
        help="Comma-separated list of probe types (default: error,database,api,infra)",
    )
    instr_parser.add_argument(
        "--utopia-mode",
        action="store_true",
        help="Enable function probes for detailed tracing",
    )
    instr_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print transformed code to stdout without writing to file",
    )
    instr_parser.add_argument(
        "--output-json",
        action="store_true",
        help="Output results as JSON",
    )

    # validate
    val_parser = subparsers.add_parser("validate", help="Validate an instrumented file")
    val_parser.add_argument("file_path", help="Path to the instrumented Python file")
    val_parser.add_argument(
        "--output-json",
        action="store_true",
        help="Output results as JSON",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "instrument":
        filepath = os.path.abspath(args.file_path)
        if not os.path.isfile(filepath):
            print(f"Error: file not found: {filepath}", file=sys.stderr)
            sys.exit(1)

        probe_types_raw = {t.strip() for t in args.probe_types.split(",")}
        invalid = probe_types_raw - ALL_PROBE_TYPES
        if invalid:
            print(f"Error: unknown probe types: {', '.join(sorted(invalid))}", file=sys.stderr)
            sys.exit(1)

        result = instrument_file(
            filepath,
            probe_types=probe_types_raw,
            utopia_mode=args.utopia_mode,
            dry_run=args.dry_run,
        )

        if args.output_json:
            print(json.dumps(result, indent=2))
        else:
            if result["success"]:
                action = "Would instrument" if args.dry_run else "Instrumented"
                print(f"{action} {filepath}")
                for probe in result["probes_added"]:
                    print(f"  [{probe['type']}] line {probe['line']}: {probe.get('function_name', '')}")
                if args.dry_run and "code" in result:
                    print("\n--- Transformed code ---")
                    print(result["code"])
            else:
                print(f"Failed to instrument {filepath}", file=sys.stderr)
                for err in result["errors"]:
                    print(f"  Error: {err}", file=sys.stderr)
                sys.exit(1)

    elif args.command == "validate":
        filepath = os.path.abspath(args.file_path)
        if not os.path.isfile(filepath):
            print(f"Error: file not found: {filepath}", file=sys.stderr)
            sys.exit(1)

        result = validate_file(filepath)

        if args.output_json:
            print(json.dumps(result, indent=2))
        else:
            if result["success"]:
                print(f"Validated {filepath}")
                for probe in result["probes_found"]:
                    print(f"  [{probe['type']}] line {probe['line']}: {probe.get('name', '')}")
                if not result["probes_found"]:
                    print("  No probes found in file")
            else:
                print(f"Validation failed for {filepath}", file=sys.stderr)
                for err in result["errors"]:
                    print(f"  Error: {err}", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    main()
