import { contextBridge, ipcRenderer } from 'electron';

// Preload of the owner-password prompt window only (sandboxed, `data:` page).
contextBridge.exposeInMainWorld('ownerPrompt', {
  submit: (password: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('owner-prompt:submit', String(password)),
  cancel: (): void => ipcRenderer.send('owner-prompt:cancel'),
});
