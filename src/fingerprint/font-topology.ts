import type { OSPlatform } from './types.js';

export const WINDOWS_EXCLUSIVE_FONTS = [
  'Segoe UI',
  'Segoe UI Semibold',
  'Segoe UI Light',
  'Calibri',
  'Cambria',
  'Consolas',
  'Candara',
  'Constantia',
  'Corbel',
  'Franklin Gothic Medium',
  'Gabriola',
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'SimSun',
  'SimHei',
  'Malgun Gothic',
  'Meiryo',
  'Yu Gothic',
  'MS Gothic',
  'MS PGothic',
  'MS UI Gothic',
  'Palatino Linotype',
] as const;

export const MACOS_EXCLUSIVE_FONTS = [
  'San Francisco',
  'SF Pro',
  'SF Pro Display',
  'SF Pro Text',
  'SF Compact',
  'SF Mono',
  'Helvetica Neue',
  'Apple Color Emoji',
  'PingFang SC',
  'PingFang TC',
  'PingFang HK',
  'Hiragino Sans',
  'Hiragino Kaku Gothic ProN',
  'Menlo',
  'Monaco',
  'Geneva',
  'Lucida Grande',
  'Optima',
  'Avenir Next',
  'Charter',
] as const;

export const LINUX_EXCLUSIVE_FONTS = [
  'Ubuntu',
  'Ubuntu Mono',
  'DejaVu Sans',
  'DejaVu Serif',
  'DejaVu Sans Mono',
  'Liberation Sans',
  'Liberation Serif',
  'Liberation Mono',
  'Nimbus Roman No9 L',
  'URW Gothic L',
] as const;

export const UNIVERSAL_FONTS = [
  'Arial',
  'Arial Black',
  'Comic Sans MS',
  'Courier New',
  'Georgia',
  'Impact',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
] as const;

export function getExcludedFontsForOs(os: OSPlatform): readonly string[] {
  if (os === 'windows') {
    return [...MACOS_EXCLUSIVE_FONTS, ...LINUX_EXCLUSIVE_FONTS];
  }
  if (os === 'macos') {
    return [...WINDOWS_EXCLUSIVE_FONTS, ...LINUX_EXCLUSIVE_FONTS];
  }
  return [...WINDOWS_EXCLUSIVE_FONTS, ...MACOS_EXCLUSIVE_FONTS];
}

export function getAllowedFontsForOs(os: OSPlatform): readonly string[] {
  if (os === 'windows') {
    return [...UNIVERSAL_FONTS, ...WINDOWS_EXCLUSIVE_FONTS];
  }
  if (os === 'macos') {
    return [...UNIVERSAL_FONTS, ...MACOS_EXCLUSIVE_FONTS];
  }
  return [...UNIVERSAL_FONTS, ...LINUX_EXCLUSIVE_FONTS];
}
