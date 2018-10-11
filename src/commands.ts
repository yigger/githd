'use strict'

import * as path from 'path';
import * as assert from 'assert';

import { Uri, commands, Disposable, workspace, window, QuickPickItem } from 'vscode';

import { Model, HistoryViewContext } from './model';
import { HistoryViewProvider } from './historyViewProvider';
import { LineDiffViewProvider } from './lineDiffViewProvider';
import { GitService, GitRepo, GitRefType, GitCommittedFile } from './gitService';

function toGitUri(uri: Uri, ref: string): Uri {
    return uri.with({
        scheme: 'git',
        path: uri.path,
        query: JSON.stringify({
            path: uri.fsPath,
            ref
        })
    });
}

async function selectBranch(gitService: GitService, repo: GitRepo, allowEnterSha?: boolean, selectCurRef?: boolean): Promise<QuickPickItem[]> {
    const refs = await gitService.getRefs(repo);
    const currentRef = await gitService.getCurrentBranch(repo);
    const SpaceChar = '\u00a0'
    const items = refs.map(ref => {
        let description: string;
        if (ref.type === GitRefType.Head) {
            description = ref.commit;
        } else if (ref.type === GitRefType.Tag) {
            description = `Tag at ${ref.commit}`;
        } else if (ref.type === GitRefType.RemoteHead) {
            description = `Remote branch at ${ref.commit}`;
        }
        let branch = { label: ref.name || ref.commit, description }
        if (selectCurRef) {
            branch.label = `${branch.label === currentRef ? `$(check)${SpaceChar}` : SpaceChar.repeat(4)} ${branch.label}`
        }
        return branch;
    });
    if (allowEnterSha) items.unshift(new EnterShaPickItem);
    return items;
}

interface RepoPickItem extends QuickPickItem {
    repo: GitRepo;
}

class EnterShaPickItem implements QuickPickItem {
    label = "Enter commit SHA";
    description = "";
    openShaTextBox = true;
}

function selectGitRepo(gitService: GitService): Thenable<GitRepo> {
    const repos: GitRepo[] = gitService.getGitRepos();
    if (repos.length === 0) {
        return null;
    }
    if (repos.length === 1) {
        return Promise.resolve(repos[0]);
    }
    const pickItems: RepoPickItem[] = repos.map(repo => {
        let label: string = '';
        return { label: path.basename(repo.root), description: repo.root, repo };
    });
    return window.showQuickPick(pickItems, { placeHolder: 'Select the git repo' })
        .then<GitRepo>(item => {
            if (item) {
                return item.repo;
            }
            return null;
        });
}

async function getRefFromQuickPickItem(item: QuickPickItem | EnterShaPickItem, inputBoxTitle: string): Promise<string> {
    return (<EnterShaPickItem>item).openShaTextBox
        ? await window.showInputBox({ prompt: inputBoxTitle })
        : item.label;
}

async function selectAuthor(gitService: GitService, repo: GitRepo): Promise<QuickPickItem[]> {
    let authors = await gitService.getAuthors(repo);
    authors.unshift({ name: 'All', email: '' });
    return authors.map(author => { return { label: author.name, description: author.email } });
}

interface Command {
    id: string;
    method: Function;
}

const Commands: Command[] = [];

function command(id: string) {
    return function (target: any, key: string, descriptor: PropertyDescriptor) {
        if (!(typeof descriptor.value === 'function')) {
            throw new Error('not supported');
        }
        Commands.push({ id, method: descriptor.value });
    }
}

export class CommandCenter {
    private _disposables: Disposable[];

    constructor(private _model: Model, private _gitService: GitService,
        private _historyView: HistoryViewProvider, private _lineDiffView: LineDiffViewProvider) {

        this._disposables = Commands.map(({ id, method }) => {
            return commands.registerCommand(id, (...args: any[]) => {
                Promise.resolve(method.apply(this, args));
            });
        });
    }
    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }

    @command('githd.clear')
    async clear(): Promise<void> {
        this._model.filesViewContext = { leftRef: null, rightRef: null, specifiedPath: null, repo: null };
    }

    @command('githd.viewHistory')
    async viewHistory(): Promise<void> {
        selectGitRepo(this._gitService).then(repo => {
            if (repo) {
                this._viewHistory({ repo });
            }
        });
    }

    @command('githd.viewFileHistory')
    async viewFileHistory(
        specifiedPath: Uri | undefined = window.activeTextEditor ? window.activeTextEditor.document.uri : undefined
    ): Promise<void> {
        if (!specifiedPath) { return; }

        return this._viewHistory({ specifiedPath, repo: await this._gitService.getGitRepo(specifiedPath) });
    }

    @command('githd.viewFolderHistory')
    async viewFolderHistory(specifiedPath: Uri): Promise<void> {
        return this.viewFileHistory(specifiedPath);
    }

    @command('githd.viewLineHistory')
    async viewLineHistory(
        file: Uri | undefined = window.activeTextEditor ? window.activeTextEditor.document.uri : undefined
    ): Promise<void> {
        if (!file) { return; }

        const line = window.activeTextEditor && window.activeTextEditor.selection.active.line + 1;
        if (!line) { return; }

        return this._viewHistory({ specifiedPath: file, line, repo: await this._gitService.getGitRepo(file) });
    }

    @command('githd.viewAllHistory')
    async viewAllHistory(): Promise<void> {
        return this._viewHistory(this._model.historyViewContext ? this._model.historyViewContext
            : { repo: this._gitService.getGitRepos()[0] }, true);
    }

    @command('githd.viewBranchHistory')
    async viewBranchHistory(context?: HistoryViewContext): Promise<void> {
        let placeHolder: string = `Select a ref to see it's history`;
        let repo: GitRepo;
        if (context) {
            repo = context.repo;
            const specifiedPath = this._model.historyViewContext.specifiedPath;
            if (specifiedPath) {
                placeHolder += ` of ${path.basename(specifiedPath.fsPath)}`;
            }
        } else {
            repo = await Promise.resolve(selectGitRepo(this._gitService));
            if (!repo) {
                return;
            }
        }
        placeHolder += ` (${repo.root})`;

        window.showQuickPick(selectBranch(this._gitService, repo), { placeHolder })
            .then(item => {
                if (item) {
                    if (context) {
                        context.branch = item.label;
                        this._viewHistory(context);
                    } else {
                        this._viewHistory({ branch: item.label, repo });
                    }
                }
            });
    }

    @command('githd.viewAuthorHistory')
    async viewAuthorHistory(): Promise<void> {
        assert(this._model.historyViewContext, 'history view context should exist');
        const context: HistoryViewContext = this._model.historyViewContext;
        let placeHolder: string = `Select a author to see his/her commits`;
        window.showQuickPick(selectAuthor(this._gitService, context.repo), { placeHolder })
            .then(item => {
                if (item) {
                    const email: string = item.description;
                    let context: HistoryViewContext = this._model.historyViewContext;
                    if (context) {
                        context.author = email;
                    }
                    this._viewHistory(context);
                }
            });
    }

    @command('githd.diffBranch')
    async diffBranch(): Promise<void> {
        selectGitRepo(this._gitService).then(async repo => {
            if (!repo) {
                return;
            }

            const sourceBranch = await this._choseBranchOnPick(repo, `Select source branch to compare (${repo.root})`, true, true);
            if (!sourceBranch) {
                window.showErrorMessage("Invalid Branch");
                return ;
            }
            
            const targetBranch = await this._choseBranchOnPick(repo, `Select target branch to compare with ${sourceBranch.label} (${repo.root})`, true);
            if (!targetBranch) {
                window.showErrorMessage("Invalid Branch");
                return ;
            }
            
            const leftRef = await getRefFromQuickPickItem(sourceBranch, `Input a ref(sha1) as a source branch`);
            const rightRef = await getRefFromQuickPickItem(targetBranch, `Input a ref(sha1) as a target branch`);
            this._model.filesViewContext = {
                repo,
                leftRef,
                rightRef,
                specifiedPath: null
            };
        });
    }

    @command('githd.diffFile')
    async diffFile(specifiedPath: Uri): Promise<void> {
        if (specifiedPath) {
            const repo: GitRepo = await this._gitService.getGitRepo(specifiedPath);
            window.showQuickPick(selectBranch(this._gitService, repo, true),
                { placeHolder: `Select a ref to see the diff of ${path.basename(specifiedPath.path)}` })
                .then(async item => {
                    if (item) {
                        const currentRef: string = await this._gitService.getCurrentBranch(repo);
                        const leftRef = await getRefFromQuickPickItem(item, `Input a ref(sha1) to compare with ${currentRef}`);
                        if (!leftRef) return;
                        this._model.filesViewContext = {
                            repo,
                            leftRef,
                            rightRef: currentRef,
                            specifiedPath
                        };
                    }
                });
        }
    }

    @command('githd.diffFolder')
    async diffFolder(specifiedPath: Uri): Promise<void> {
        return this.diffFile(specifiedPath);
    }

    @command('githd.inputRef')
    async inputRef(): Promise<void> {
        selectGitRepo(this._gitService).then(repo => {
            if (!repo) {
                return;
            }
            window.showInputBox({ placeHolder: `Input a ref(sha1) to see it's committed files` })
                .then(ref => this._model.filesViewContext = { leftRef: null, rightRef: ref.trim(), specifiedPath: null, repo });
        });
    }

    @command('githd.openCommittedFile')
    async openCommittedFile(file: GitCommittedFile): Promise<void> {
        let rightRef: string = this._model.filesViewContext.rightRef;
        let leftRef: string = rightRef + '~';
        let title = rightRef;
        if (this._model.filesViewContext.leftRef) {
            leftRef = this._model.filesViewContext.leftRef;
            title = `${leftRef} .. ${rightRef}`;
        }
        return await commands.executeCommand<void>('vscode.diff', toGitUri(file.uri, leftRef), toGitUri(file.uri, rightRef),
            title + ' | ' + path.basename(file.gitRelativePath), { preview: true });
    }

    @command('githd.openLineDiff')
    async openLineDiff(content: string): Promise<void> {
        this._lineDiffView.update(content);
        workspace.openTextDocument(LineDiffViewProvider.defaultUri)
            .then(doc => window.showTextDocument(doc, { preview: true, preserveFocus: true })
                .then(() => commands.executeCommand('cursorTop')));
    }

    @command('githd.setExpressMode')
    async setExpressMode(): Promise<void> {
        this._historyView.express = !this._historyView.express;
    }

    private async _viewHistory(context: HistoryViewContext, all: boolean = false): Promise<void> {
        this._historyView.loadAll = all;
        await this._model.setHistoryViewContext(context);
    }

    private async _choseBranchOnPick(repo: GitRepo, placeholder: string, allowEnterSha: boolean, defaultRef: boolean = false) {
        return window.showQuickPick(selectBranch(this._gitService, repo, allowEnterSha), { placeHolder: placeholder })
            .then(async item => {
               return item; 
            });
    }
}
