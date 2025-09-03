'use client'

import { SandboxInstance } from '@blaxel/core';
import { useEffect, useState } from 'react';

interface FileSystemItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

interface CodeViewerTabProps {
  sandboxInstance: SandboxInstance | null;
}

export function CodeViewerTab({ sandboxInstance }: CodeViewerTabProps) {
  const [currentPath, setCurrentPath] = useState<string>('/blaxel/app');
  const [items, setItems] = useState<FileSystemItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [editedContent, setEditedContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Load directory contents
  const loadDirectory = async (path: string) => {
    if (!sandboxInstance) return;

    setLoading(true);
    setError(null);
    try {
      const result = await sandboxInstance.fs.ls(path);
      const itemList: FileSystemItem[] = [];

      // Add directories
      if (result.subdirectories) {
        result.subdirectories.forEach(dir => {
          itemList.push({
            name: dir.name || '',
            path: dir.path || `${path}/${dir.name}`,
            type: 'directory'
          });
        });
      }

      // Add files
      if (result.files) {
        result.files.forEach(file => {
          itemList.push({
            name: file.name || '',
            path: file.path || `${path}/${file.name}`,
            type: 'file',
            size: file.size
          });
        });
      }

      // Sort: directories first, then alphabetically
      itemList.sort((a, b) => {
        if (a.type === 'directory' && b.type === 'file') return -1;
        if (a.type === 'file' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
      });

      setItems(itemList);
      setCurrentPath(path);
    } catch (err) {
      console.error('Error loading directory:', err);
      setError(`Failed to load directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

    // Load file content
  const loadFile = async (path: string) => {
    if (!sandboxInstance) return;

    setLoading(true);
    setError(null);
    setIsEditing(false);
    try {
      const content = await sandboxInstance.fs.read(path);
      setFileContent(content);
      setEditedContent(content);
      setSelectedFile(path);
    } catch (err) {
      console.error('Error loading file:', err);
      setError(`Failed to load file: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setFileContent('');
      setEditedContent('');
    } finally {
      setLoading(false);
    }
  };

  // Save file content
  const saveFile = async () => {
    if (!sandboxInstance || !selectedFile) return;

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await sandboxInstance.fs.write(selectedFile, editedContent);
      setFileContent(editedContent);
      setIsEditing(false);
      setSuccessMessage('File saved successfully!');
      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      console.error('Error saving file:', err);
      setError(`Failed to save file: ${err instanceof Error ? err.message : 'Unknown error'}`);
      // Clear error after 5 seconds
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsSaving(false);
    }
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditedContent(fileContent);
    setIsEditing(false);
  };

  // Start editing
  const startEdit = () => {
    setEditedContent(fileContent);
    setIsEditing(true);
  };

  // Check if there are unsaved changes
  const hasUnsavedChanges = () => {
    return isEditing && editedContent !== fileContent;
  };

  // Handle item click
  const handleItemClick = async (item: FileSystemItem) => {
    // Check for unsaved changes before switching files
    if (hasUnsavedChanges()) {
      const confirm = window.confirm('You have unsaved changes. Do you want to discard them?');
      if (!confirm) return;
    }

    if (item.type === 'directory') {
      await loadDirectory(item.path);
      setSelectedFile(null);
      setFileContent('');
      setEditedContent('');
      setIsEditing(false);
    } else {
      await loadFile(item.path);
    }
  };

  // Navigate to parent directory
  const navigateUp = () => {
    // Check for unsaved changes before navigating
    if (hasUnsavedChanges()) {
      const confirm = window.confirm('You have unsaved changes. Do you want to discard them?');
      if (!confirm) return;
    }

    const segments = currentPath.split('/').filter(Boolean);
    segments.pop();
    const parentPath = segments.length > 0 ? '/' + segments.join('/') : '/';
    loadDirectory(parentPath);
    setSelectedFile(null);
    setFileContent('');
    setEditedContent('');
    setIsEditing(false);
  };

  // Get file extension for syntax highlighting hint
  const getFileLanguage = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'json': 'json',
      'css': 'css',
      'scss': 'scss',
      'html': 'html',
      'xml': 'xml',
      'md': 'markdown',
      'py': 'python',
      'rb': 'ruby',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'rs': 'rust',
      'go': 'go',
      'php': 'php',
      'sql': 'sql',
      'sh': 'bash',
      'bash': 'bash',
      'yml': 'yaml',
      'yaml': 'yaml',
      'toml': 'toml',
      'ini': 'ini',
      'env': 'bash'
    };
    return languageMap[ext || ''] || 'text';
  };

  // Load initial directory on mount
  useEffect(() => {
    if (sandboxInstance) {
      loadDirectory(currentPath);
    }
  }, [sandboxInstance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Save on Ctrl+S or Cmd+S
      if (isEditing && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
      // Cancel on Escape
      if (isEditing && e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, editedContent]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sandboxInstance) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--background)', color: 'var(--muted-foreground)' }}>
        <p>Sandbox not available</p>
      </div>
    );
  }

  return (
    <div className="h-full flex" style={{ background: 'var(--background)' }}>
      {/* File Explorer Sidebar */}
      <div className="w-80 border-r flex flex-col" style={{ borderColor: 'var(--border)', background: 'var(--secondary)' }}>
        {/* Path Navigation */}
        <div className="p-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={navigateUp}
            disabled={currentPath === '/'}
            className="p-1 rounded hover:bg-white/10 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-colors"
            title="Go up"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div className="flex-1 text-sm font-mono truncate" style={{ color: 'var(--muted-foreground)' }}>
            {currentPath}
          </div>
        </div>

        {/* File List */}
        <div className="flex-1 overflow-auto p-2">
          {loading && items.length === 0 ? (
            <div className="text-center py-4" style={{ color: 'var(--muted-foreground)' }}>
              Loading...
            </div>
          ) : error ? (
            <div className="text-center py-4 text-sm" style={{ color: 'var(--error)' }}>
              {error}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-4" style={{ color: 'var(--muted-foreground)' }}>
              Empty directory
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((item, index) => (
                                <button
                  key={index}
                  onClick={() => handleItemClick(item)}
                  className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-2 cursor-pointer transition-colors ${
                    selectedFile === item.path ? '' : 'hover:bg-white/5'
                  }`}
                  style={{
                    background: selectedFile === item.path ? 'var(--muted)' : undefined,
                    color: 'var(--foreground)'
                  }}
                >
                  {item.type === 'directory' ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  )}
                  <span className="flex-1 truncate">{item.name}</span>
                  {item.type === 'file' && item.size !== undefined && (
                    <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      {item.size < 1024 ? `${item.size}B` :
                       item.size < 1048576 ? `${(item.size / 1024).toFixed(1)}KB` :
                       `${(item.size / 1048576).toFixed(1)}MB`}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Code Viewer */}
      <div className="flex-1 flex flex-col">
        {selectedFile ? (
          <>
            {/* File Header */}
            <div className="p-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', background: 'var(--secondary)' }}>
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-sm font-mono flex items-center gap-1">
                  {selectedFile.split('/').pop()}
                  {hasUnsavedChanges() && <span style={{ color: 'var(--warning)' }}>●</span>}
                </span>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                  {getFileLanguage(selectedFile)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {!isEditing ? (
                  <button
                    onClick={startEdit}
                    className="px-3 py-1 text-sm rounded hover:bg-white/10 cursor-pointer transition-colors flex items-center gap-1"
                    style={{ color: 'var(--foreground)' }}
                    title="Edit file"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Edit
                  </button>
                ) : (
                  <>
                    <button
                      onClick={saveFile}
                      disabled={isSaving}
                      className="px-3 py-1 text-sm rounded hover:bg-green-600 cursor-pointer transition-colors flex items-center gap-1 disabled:opacity-50"
                      style={{ background: 'var(--success)', color: 'var(--primary-foreground)' }}
                      title="Save changes"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V2" />
                      </svg>
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="px-3 py-1 text-sm rounded hover:bg-white/10 cursor-pointer transition-colors"
                      style={{ color: 'var(--foreground)' }}
                      title="Cancel editing"
                    >
                      Cancel
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    if (hasUnsavedChanges()) {
                      const confirm = window.confirm('You have unsaved changes. Do you want to discard them?');
                      if (!confirm) return;
                    }
                    setSelectedFile(null);
                    setFileContent('');
                    setEditedContent('');
                    setIsEditing(false);
                  }}
                  className="p-1 rounded hover:bg-white/10 cursor-pointer transition-colors"
                  title="Close file"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Code Content */}
            <div className="flex-1 overflow-auto relative">
              {loading ? (
                <div className="p-4 text-center" style={{ color: 'var(--muted-foreground)' }}>
                  Loading file...
                </div>
              ) : isEditing ? (
                <textarea
                  value={editedContent}
                  onChange={(e) => setEditedContent(e.target.value)}
                  className="w-full h-full p-4 text-sm font-mono resize-none outline-none"
                  style={{
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    border: 'none'
                  }}
                  placeholder="Empty file"
                  spellCheck={false}
                />
              ) : (
                <pre className="p-4 text-sm font-mono whitespace-pre-wrap break-all" style={{ background: '#1e1e1e', color: '#d4d4d4' }}>
                  <code>{fileContent || 'Empty file'}</code>
                </pre>
              )}
              {successMessage && (
                <div className="absolute top-0 left-0 right-0 p-3 text-sm flex items-center justify-center" style={{ background: 'var(--success)', color: 'white' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {successMessage}
                </div>
              )}
              {error && (
                <div className="absolute bottom-0 left-0 right-0 p-2 text-sm" style={{ background: 'var(--error)', color: 'white' }}>
                  {error}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
            <div className="text-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ opacity: 0.5 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              <p className="text-lg">Select a file to view</p>
              <p className="text-sm mt-2">Navigate through directories and click on files to view their contents</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
