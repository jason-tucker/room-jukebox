import { contextBridge } from 'electron';

// Intentionally empty for now; the renderer API is added in later milestones.
contextBridge.exposeInMainWorld('roomJukebox', {});
