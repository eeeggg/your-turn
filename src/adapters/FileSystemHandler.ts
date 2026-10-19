import * as vscode from 'vscode';
import { log, logError } from '@/core/Log';
import type { FileAccess } from '@/core/ClientHandlers';
import { selectLines } from '@/core/TextFileRange';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Handles ACP file system requests using VS Code's workspace filesystem API.
 * This gives us access to unsaved editor buffers automatically.
 */
export class FileSystemHandler implements FileAccess {

  /**
   * Read a text file. Uses VS Code API to include unsaved editor content.
   */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);

      // Check if the file is open in an editor with unsaved changes
      const openDoc = vscode.workspace.textDocuments.find(
        doc => doc.uri.fsPath === uri.fsPath
      );

      const content = openDoc
        ? openDoc.getText()
        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');

      return { content: selectLines(content, params.line, params.limit) };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  /**
   * Write a text file. Creates parent directories if needed.
   * Opens the file in the editor so the user can see changes.
   */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);
      const encoded = Buffer.from(params.content, 'utf-8');

      await vscode.workspace.fs.writeFile(uri, encoded);

      // Open the file in the editor so the user sees the change
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
