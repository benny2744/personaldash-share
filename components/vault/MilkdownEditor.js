'use client';

import React from 'react';
import { MilkdownProvider, Milkdown, useEditor } from '@milkdown/react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import '@milkdown/crepe/theme/frame.css';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/toolbar.css';

function MilkdownInner({
  initialContent,
  onChange,
  readOnly = false,
  compact = false,
  onReady,
}) {
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = React.useRef(onReady);
  onReadyRef.current = onReady;

  const { loading } = useEditor(
    (root) => {
      const crepe = new Crepe({
        root,
        defaultValue: initialContent || '',
        features: {
          [Crepe.Feature.TopBar]: false,
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.AI]: false,
          [Crepe.Feature.ImageBlock]: false,
          // Drag handle + slash menu are edit-mode affordances; skip the
          // chrome entirely in read-only previews.
          [Crepe.Feature.BlockEdit]: !readOnly,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: 'Start writing...',
          },
        },
      });

      crepe.setReadonly(readOnly);

      if (!readOnly) {
        crepe.on((api) => {
          api.markdownUpdated((_ctx, markdown) => {
            onChangeRef.current?.(markdown);
          });
        });
      }

      onReadyRef.current?.(crepe);

      return crepe.editor;
    },
    [initialContent, readOnly],
  );

  return (
    <div
      className={`milkdown-container ${compact ? 'milkdown-compact' : ''} ${
        loading ? 'milkdown-loading' : ''
      }`}
    >
      <Milkdown />
    </div>
  );
}

export default function MilkdownEditor({
  content,
  onChange,
  readOnly = false,
  compact = false,
  onReady,
}) {
  return (
    <MilkdownProvider>
      <MilkdownInner
        initialContent={content}
        onChange={onChange}
        readOnly={readOnly}
        compact={compact}
        onReady={onReady}
      />
    </MilkdownProvider>
  );
}
