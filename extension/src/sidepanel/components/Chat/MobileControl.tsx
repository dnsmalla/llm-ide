import React, { useState, useCallback, useEffect } from 'react';

interface MobileControlProps {
  isConnected: boolean;
  onCommand: (command: string, data?: any) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function MobileControl({
  isConnected,
  onCommand,
  onConnect,
  onDisconnect
}: MobileControlProps) {
  const [showQuickActions, setShowQuickActions] = useState(false);

  const quickActions = [
    { id: 'scroll-up', label: '⬆️ Scroll Up', command: 'mobile:scroll', data: { direction: 'up' } },
    { id: 'scroll-down', label: '⬇️ Scroll Down', command: 'mobile:scroll', data: { direction: 'down' } },
    { id: 'tap', label: '👆 Tap', command: 'mobile:tap' },
    { id: 'back', label: '⬅️ Back', command: 'mobile:back' },
    { id: 'home', label: '🏠 Home', command: 'mobile:home' },
    { id: 'screenshot', label: '📸 Screenshot', command: 'mobile:screenshot' },
  ];

  const handleQuickAction = (action: any) => {
    onCommand(action.command, action.data);
  };

  // Keyboard shortcuts for mobile control
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isConnected) return;

      // Arrow keys for navigation
      if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        onCommand('mobile:scroll', { direction: 'up' });
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        onCommand('mobile:scroll', { direction: 'down' });
      }
      // Backspace for back
      else if (e.key === 'Backspace' && e.altKey) {
        e.preventDefault();
        onCommand('mobile:back');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isConnected, onCommand]);

  return (
    <div className="mobile-control">
      {/* Connection Status */}
      <div className="mobile-connection-header">
        <div className={`connection-dot ${isConnected ? 'connected' : 'disconnected'}`}></div>
        <span className="connection-status">
          {isConnected ? 'Connected to Mobile' : 'Mobile Offline'}
        </span>
        <button
          className="connection-toggle"
          onClick={isConnected ? onDisconnect : onConnect}
          aria-label={isConnected ? 'Disconnect' : 'Connect to mobile'}
        >
          {isConnected ? '🔗' : '🔌'}
        </button>
      </div>

      {/* Quick Actions */}
      <div className="mobile-quick-actions">
        <button
          className="quick-actions-toggle"
          onClick={() => setShowQuickActions(!showQuickActions)}
          title="Quick mobile commands"
        >
          ⚡ Quick Actions
        </button>

        {showQuickActions && (
          <div className="quick-actions-menu">
            {quickActions.map((action) => (
              <button
                key={action.id}
                className="quick-action-item"
                onClick={() => handleQuickAction(action)}
                disabled={!isConnected}
                title={`${action.label} - ${action.command}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Keyboard Shortcuts */}
      <div className="mobile-shortcuts">
        <div className="shortcuts-label">Shortcuts (when connected):</div>
        <div className="shortcuts-list">
          <div className="shortcut">
            <kbd>Alt</kbd> + <kbd>↑</kbd> Scroll Up
          </div>
          <div className="shortcut">
            <kbd>Alt</kbd> + <kbd>↓</kbd> Scroll Down
          </div>
          <div className="shortcut">
            <kbd>Alt</kbd> + <kbd>Backspace</kbd> Back
          </div>
          <div className="shortcut">
            <kbd>Ctrl/Cmd</kbd> + <kbd>M</kbd> Voice
          </div>
        </div>
      </div>
    </div>
  );
}
