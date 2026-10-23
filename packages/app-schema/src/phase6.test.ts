import { describe, expect, it } from 'vitest';
import {
  BACKEND_HOST_METHODS,
  PROJECT_SURFACES,
  RPC_ERROR_CODES,
  SURFACES,
  SURFACE_PRESENTATIONS,
  SURFACES_WITH_OPTIONAL_TITLE,
  backendMethodAllowed,
  isProjectSurface,
  methodAllowed,
  permissionsForMethod,
  validateManifest,
} from './index.js';

const app = (surfaces: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: 'com.example.brand-desk',
  name: 'Brand desk',
  version: '1.0.0',
  sdk: '^1.6.0',
  entry: 'dist/app.js',
  surfaces,
});

describe('project extensions (Phase 6)', () => {
  it('adds the project tab and project settings after the Phase 3 surfaces', () => {
    expect(SURFACES.slice(-5, -3)).toEqual(['project.tab', 'project.settings']);
    expect(SURFACE_PRESENTATIONS['project.tab']).toBe('tab');
    expect(SURFACE_PRESENTATIONS['project.settings']).toBe('screen');
    expect(PROJECT_SURFACES).toEqual(['project.widget', 'project.tab', 'project.settings', 'task.action', 'issue.action', 'record.card']);
    expect(isProjectSurface('project.tab')).toBe(true);
    expect(isProjectSurface('app')).toBe(false);
    expect(SURFACES_WITH_OPTIONAL_TITLE).toEqual(expect.arrayContaining(['project.tab', 'project.settings']));
  });

  it('accepts project surfaces with or without a title and rejects unknown options', () => {
    expect(validateManifest(app({ 'project.tab': { title: 'Marka' }, 'project.settings': {} })).ok).toBe(true);
    expect(validateManifest(app({ 'project.tab': {} })).ok).toBe(true);
    const blank = validateManifest(app({ 'project.tab': { title: ' ' } }));
    expect(blank.ok).toBe(false);
    const unknown = validateManifest(app({ 'project.settings': { icon: 'gear' } }));
    expect(unknown.ok).toBe(false);
  });

  it('opens project.config to every app, in the UI and in backend code', () => {
    expect(permissionsForMethod('project.config.get')).toEqual([]);
    expect(methodAllowed('project.config.get', [])).toBe(true);
    expect(methodAllowed('project.config.set', [])).toBe(true);
    expect(BACKEND_HOST_METHODS).toEqual(expect.arrayContaining(['project.config.get', 'project.config.set']));
    expect(backendMethodAllowed('project.config.set', [])).toBe(true);
  });

  it('names calls to projects the app is not enabled in', () => {
    expect(RPC_ERROR_CODES).toContain('project_not_enabled');
  });
});
