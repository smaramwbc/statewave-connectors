import * as vscode from "vscode";
import type { StatusModel } from "@statewavedev/ide-core";

/**
 * The persistent trust surface. Reactive, quiet (no notifications), updated
 * in real time from the engine state. Clicking opens the action/diagnostics
 * menu so the user can always answer "did Statewave remember this?".
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.command = "statewave.statusMenu";
    this.item.text = "$(database) Statewave";
    this.item.tooltip = "Statewave — initializing";
    this.item.show();
  }

  update(model: StatusModel): void {
    this.item.text = `$(database) ${model.text}`;
    this.item.tooltip = new vscode.MarkdownString(
      model.tooltip.split("\n").join("  \n"),
    );
    this.item.backgroundColor =
      model.kind === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : model.kind === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
