'use client';

import { useChat } from '@ai-sdk/react';
import { SandboxInstance } from '@blaxel/core';
export function Chatbot({ sandbox, className }: { sandbox: SandboxInstance, className?: string }) {
  const { messages, input, handleInputChange, handleSubmit, status, error } = useChat({
    api: '/api/chat',
    maxSteps: 5, // Enable multi-step tool calling
    // Handle client-side tool calling
    async onToolCall({ toolCall }) {
      const tool = sandbox.fs.tools[toolCall.toolName as keyof typeof sandbox.fs.tools]
      if (tool) {
        // @ts-expect-error just let it be
        const result = await tool.execute(toolCall.args)
        return result
      } else {
        console.error('Tool not found', toolCall.toolName)
      }
    }
  });

  return (
    <div className={`flex flex-col bg-white rounded-lg border border-gray-200 shadow-sm h-full ${className || ''}`}>
      <div className="bg-blue-600 text-white px-4 py-2 rounded-t-lg flex justify-between items-center">
        <h3 className="text-sm font-medium">Sandbox Assistant</h3>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 ${
                message.role === 'user'
                  ? 'bg-blue-600 text-gray-100'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              {/* Render message content */}
              {message.parts.map((part, index) => {
                switch (part.type) {
                  case 'text':
                    return <div key={index}>{part.text}</div>;
                }
              })}
            </div>
          </div>
        ))}

        {status === 'submitted' && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg px-3 py-2 max-w-[80%]">
              <div className="flex space-x-2">
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
            Error: {error.toString()}
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 p-3">
        <form onSubmit={handleSubmit} className="flex">
          <input
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Type your message..."
            className="flex-grow px-3 py-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={status === 'submitted'}
          />
          <button
            type="submit"
            className={`px-4 py-2 rounded-r-md ${
              status === 'submitted'
                ? 'bg-gray-300 text-gray-500'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
            disabled={status === 'submitted'}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}