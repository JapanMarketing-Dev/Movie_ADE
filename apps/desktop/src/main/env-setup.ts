// Imported first by main: environment the @solocut/* packages read (templates location, Electron's Node for
// the CLI). Must run before those packages are evaluated.
import { templatesDir } from './paths';

process.env.SOLOCUT_TEMPLATES_DIR ??= templatesDir();
process.env.SOLOCUT_ELECTRON ??= process.execPath;
