# Core Run Semantics Assessment

## Scope

This note reviews the run semantics in `core/play-26-6.html`, specifically the behaviour around browser selection, current-query highlighting, the `Run` / `Run selected` / `Run one` button state, `Run all`, and the `Ctrl/Cmd+Enter` shortcuts.

It is based on the implementation in:

- [`postOne`](../core/play-26-6.html#L3325)
- [`postAll`](../core/play-26-6.html#L3362)
- [`getQueryUnderCursor`](../core/play-26-6.html#L3696)
- [`splitAllQueries`](../core/play-26-6.html#L3741)
- [`updateRunButtons`](../core/play-26-6.html#L3842)
- [`renderQueryBackdrop`](../core/play-26-6.html#L3975)

## Verdict

The review in `.agent/core/run-behavioue.md` is accurate.

The core issue is not just that the UI feels a bit confusing. The implementation does not have one authoritative execution target that is shared by the visual highlight, the browser selection, the button label, and the run command.

That makes the editor unsafe in a SQL context because the user cannot reliably answer the most important question: "What will run if I press `Ctrl/Cmd+Enter` right now?"

## Main Problems

### There Are Multiple Selection Models

The editor currently has at least two visible selection concepts:

- The browser textarea selection.
- The custom current-query highlight rendered through the backdrop.

Those do not mean the same thing.

The browser selection is used by `postOne` to decide whether to run selected/intersecting parsed statements. The custom highlight is derived from the cursor position in `renderQueryBackdrop`. It represents the active query, not necessarily the query or text that will run.

This is especially confusing because both are visual highlights inside the same editor.

### `Run Selected` Does Not Mean Selected Text

When there is a selection in multi-query mode, `postOne` does not execute the exact selected text. Instead, it tokenizes the whole editor and runs every parsed query whose significant span intersects the selection.

That means selecting part of a statement can still execute the full statement.

This is counter to a common SQL workflow where users select a fragment, CTE body, predicate, or small subquery to run only that text while debugging.

The label `Run selected` therefore over-promises. It implies selected text execution, but the implementation performs selected statement execution.

### Running Mutates the Editor Selection

`getQueryUnderCursor` calls `query_area.setSelectionRange(...)` before returning the query text.

That means running a statement changes the textarea selection as a side effect. This can leave the editor showing a browser selection that was created by the last run, not necessarily by the user.

After that, button state and later run behaviour may be influenced by a selection that was created programmatically.

### Button State Is Derived Too Loosely

`updateRunButtons` derives the button label from:

- Whether the editor is in multi-query mode.
- Whether `selectionStart !== selectionEnd`.

It does not compute the exact execution target. As a result, the button can say `Run selected` even when the selected text is not what will actually be submitted.

The `Run all` button visibility is also stateful and conditional, which makes the top-level action model harder to read.

### Shortcut Semantics Add More Ambiguity

The shortcut model is:

- `Ctrl/Cmd+Enter`: run current/selected target.
- `Ctrl/Cmd+Shift+Enter`: run all in multi-query mode.

This is not inherently bad, but it becomes risky because the current/selected target is ambiguous.

Shortcuts should be especially predictable because they bypass the user's final chance to inspect a button label before executing.

### Parallel Multi-query Execution Changes Script Semantics

`postMulti` splits the editor content into individual statements and executes consecutive SELECT-like statements in parallel, with non-SELECT statements acting as barriers.

This may be useful in some cases, but it changes the mental model from "run this script" to "split this script into requests and partially parallelize it."

That has real semantic consequences:

- Statements are sent as separate HTTP requests.
- Consecutive SELECT-like statements may run concurrently.
- Query ordering is no longer a simple top-to-bottom execution model.
- Users may assume script-like sequencing where the implementation is doing request orchestration.

For ClickHouse this might often work fine, but it is still a meaningful behaviour change and should not be implicit unless the UI makes it very clear.

## What The Review Got Right

The following points from the original review are fair:

- The dual highlighting system is confusing.
- The variable `Run` button state is confusing.
- Having both `Run selected`/`Run one` and `Run all` increases cognitive load.
- It is possible for the UI to suggest one target while the shortcut executes another.
- Partial selection executing the full statement is surprising for SQL users.
- The blur/click behaviour can feel inconsistent because focus, browser selection, and backdrop highlighting are separate mechanisms.

The strongest point is the safety concern: this interface can make it too easy to execute a different query than the user intended.

## What Is Worth Keeping

There are useful ideas in the implementation:

- Stacked results for multiple queries could be valuable.
- Lexer-based statement detection is a good foundation.
- A current-statement visual affordance can be useful if it is clearly distinct from text selection.
- `Run all` is a legitimate action.
- Parallel execution may be useful as an explicit advanced mode.

The problem is not that these features exist. The problem is that their semantics are currently mixed together.

## Recommended Direction

The editor should have one shared run-target model used by:

- Visual highlighting.
- Button labels.
- Keyboard shortcuts.
- Actual execution.

A simpler model would be:

1. If there is a non-empty browser selection, run exactly the selected text.
2. If there is no browser selection, run the statement containing the cursor.
3. `Run all` always runs all statements explicitly.
4. Multi-query execution should be sequential by default.
5. Parallel execution should be opt-in and clearly labelled.

Under this model, the UI can always explain itself:

- Selected text means selected text will run.
- Current-statement highlight means the statement that will run when there is no selection.
- `Run all` means all statements will run.

That is much safer and easier to reason about.

## Conclusion

The assessment in `.agent/core/run-behavioue.md` is not overly harsh. It identifies a real design flaw in the current implementation.

The current code has good building blocks, but the run semantics should be simplified before this becomes a production-facing default. In a query editor, predictability matters more than cleverness. The user should never have to infer what will execute from overlapping selection systems.
