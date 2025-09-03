'use client'

import { RefObject } from 'react';

interface PreviewTabProps {
  previewUrl: string | null;
  isPreviewLoading: boolean;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onRefresh: () => void;
}

export function PreviewTab({ previewUrl, isPreviewLoading, iframeRef, onRefresh }: PreviewTabProps) {
  return (
    <div className="h-full relative" style={{ background: 'var(--background)' }}>
      {previewUrl ? (
        <div className="absolute inset-0 p-4">
          <div className="relative h-full w-full rounded-lg overflow-hidden shadow-2xl border-4" style={{ border: '4px solid var(--border)' }}>
            <div className="h-8 flex items-center px-4" style={{ background: 'var(--muted)' }}>
              <div className="flex space-x-2">
                <div className="h-3 w-3 rounded-full" style={{ background: 'var(--error)' }}></div>
                <div className="h-3 w-3 rounded-full" style={{ background: 'var(--warning)' }}></div>
                <div className="h-3 w-3 rounded-full" style={{ background: 'var(--success)' }}></div>
              </div>
              <div className="flex-1 text-sm font-medium text-center truncate px-4" style={{ color: 'var(--muted-foreground)' }}>
                {previewUrl}
              </div>
              <button
                onClick={onRefresh}
                className="p-1 rounded-full transition-colors cursor-pointer hover:bg-white/10"
                style={{ color: 'var(--muted-foreground)' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            {/* Loading overlay for preview */}
            {isPreviewLoading ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center" style={{ background: 'var(--muted)', opacity: 0.7 }}>
                <div className="h-12 w-12 rounded-full border-4 animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--primary)', borderRightColor: 'transparent', borderBottomColor: 'var(--primary)', borderLeftColor: 'transparent' }}></div>
                <p className="mt-4 text-sm" style={{ color: 'var(--primary-foreground)' }}>Loading preview...</p>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                src={previewUrl}
                className="w-full h-[calc(100%-32px)]"
                title="Sandbox Preview"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted-foreground)' }}>
          No preview available
        </div>
      )}
    </div>
  );
}
