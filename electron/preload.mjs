import process from "node:process";
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("vibeLocalizeDesktop", {
  platform: process.platform,
  isDesktopApp: true
});
