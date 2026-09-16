'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function ApprovalCard({ approval, onApproval }) {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-3">
      <div className="text-sm font-semibold text-amber-900">
        Approval required
      </div>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-amber-950">
        {approval.command || JSON.stringify(approval, null, 2)}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
        {(approval.choices || ['once', 'session', 'always', 'deny']).map(
          (choice) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === 'deny' ? 'destructive' : 'default'}
              onClick={() => onApproval?.(choice)}
            >
              {choice}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

function QuestionChoices({ choices, selected, multiSelect, onSelect }) {
  if (multiSelect) {
    return (
      <div className="mt-2 flex flex-col gap-1">
        {choices.map((choice) => (
          <label
            key={choice}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-container-high)]"
          >
            <input
              type="checkbox"
              checked={selected.includes(choice)}
              onChange={(event) =>
                onSelect?.((current) =>
                  event.target.checked
                    ? [...current, choice]
                    : current.filter((item) => item !== choice),
                )
              }
            />
            <span>{choice}</span>
          </label>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {choices.map((choice) => (
        <Button
          key={choice}
          size="sm"
          variant="secondary"
          onClick={() => onSelect?.(choice)}
        >
          {choice}
        </Button>
      ))}
    </div>
  );
}

function QuestionTextAnswer({ disabled, onSubmit }) {
  const [text, setText] = useState('');
  return (
    <div className="mt-2 flex gap-2">
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Your answer"
        disabled={disabled}
      />
      <Button
        size="sm"
        disabled={disabled || !text.trim()}
        onClick={() => {
          onSubmit?.(text.trim());
          setText('');
        }}
      >
        Send
      </Button>
    </div>
  );
}

function AnsweredBadge({ answer }) {
  return (
    <Badge variant="status-done" className="shrink-0">
      ✓ {answer}
    </Badge>
  );
}

function SingleClarify({ clarify, onClarify }) {
  const choices = Array.isArray(clarify.choices) ? clarify.choices : [];
  const multiSelect = Boolean(clarify.multi_select) && choices.length > 0;
  const [selected, setSelected] = useState([]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] px-3 py-3">
      <div className="text-sm font-semibold">Clarification needed</div>
      {clarify.question ? (
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {clarify.question}
        </p>
      ) : null}
      {choices.length > 0 ? (
        <>
          <QuestionChoices
            choices={choices}
            selected={selected}
            multiSelect={multiSelect}
            onSelect={(next) => {
              if (multiSelect) {
                setSelected(next);
              } else {
                onClarify?.(next);
              }
            }}
          />
          {multiSelect ? (
            <div className="mt-3">
              <Button
                size="sm"
                disabled={selected.length === 0}
                onClick={() => onClarify?.(JSON.stringify(selected))}
              >
                Confirm
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <QuestionTextAnswer onSubmit={(text) => onClarify?.(text)} />
      )}
    </div>
  );
}

function BatchQuestion({ question, index, onAnswer }) {
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const multiSelect = Boolean(question.multi_select) && choices.length > 0;
  const [selected, setSelected] = useState([]);

  return (
    <li className="rounded-xl border border-[var(--border)] bg-[var(--surface-container-low)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm text-[var(--text-primary)]">
          <span className="mr-1.5 font-semibold text-[var(--text-muted)]">
            {index + 1}.
          </span>
          {question.question}
        </p>
        {question.answered ? <AnsweredBadge answer={question.answer} /> : null}
      </div>
      {choices.length > 0 ? (
        <>
          <QuestionChoices
            choices={choices}
            selected={selected}
            multiSelect={multiSelect}
            onSelect={(next) => {
              if (multiSelect) {
                setSelected(next);
              } else {
                onAnswer?.(next);
              }
            }}
          />
          {multiSelect ? (
            <div className="mt-2">
              <Button
                size="sm"
                disabled={selected.length === 0}
                onClick={() => onAnswer?.(JSON.stringify(selected))}
              >
                Confirm
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <QuestionTextAnswer onSubmit={(text) => onAnswer?.(text)} />
      )}
    </li>
  );
}

function BatchClarify({ clarify, onClarify }) {
  const questions = Array.isArray(clarify.questions) ? clarify.questions : [];
  const answeredCount = questions.filter(
    (question) => question.answered,
  ).length;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Clarification needed</div>
        <Badge variant="secondary">
          {answeredCount}/{questions.length} answered
        </Badge>
      </div>
      <ol className="mt-3 space-y-2">
        {questions.map((question, index) => (
          <BatchQuestion
            key={question.qid}
            question={question}
            index={index}
            onAnswer={(answer) => onClarify?.(answer, question.qid)}
          />
        ))}
      </ol>
    </div>
  );
}

function SecretCard({ sudo, secret, onSecret }) {
  const [secretValue, setSecretValue] = useState('');
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] px-3 py-3">
      <div className="text-sm font-semibold">
        {sudo ? 'Password required' : 'Secret required'}
      </div>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {(sudo || secret).prompt}
      </p>
      <div className="mt-3 flex gap-2">
        <Input
          type="password"
          value={secretValue}
          onChange={(event) => setSecretValue(event.target.value)}
          placeholder={sudo ? 'Password' : 'Secret value'}
          autoComplete="off"
        />
        <Button
          size="sm"
          onClick={() => {
            onSecret?.(sudo ? 'sudo' : 'secret', secretValue);
            setSecretValue('');
          }}
          disabled={!secretValue}
        >
          Submit
        </Button>
      </div>
    </div>
  );
}

export default function PromptDialogs({
  approval,
  clarify,
  sudo,
  secret,
  onApproval,
  onClarify,
  onSecret,
}) {
  if (!approval && !clarify && !sudo && !secret) return null;

  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--surface-container-low)] px-4 py-3">
      {approval ? (
        <ApprovalCard approval={approval} onApproval={onApproval} />
      ) : null}
      {clarify?.batch ? (
        <BatchClarify clarify={clarify} onClarify={onClarify} />
      ) : clarify ? (
        <SingleClarify clarify={clarify} onClarify={onClarify} />
      ) : null}
      {sudo || secret ? (
        <SecretCard sudo={sudo} secret={secret} onSecret={onSecret} />
      ) : null}
    </div>
  );
}
