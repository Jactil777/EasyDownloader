const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easyDownloader', {
  onUpdateStatus(callback) {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update')
});
