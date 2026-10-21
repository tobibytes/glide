import { Action, ActionPanel, Form, LaunchProps, showToast } from "@raycast/api";
import { useRef } from "react";

export default function Command(props: LaunchProps<{ draftValues: { title?: string } }>) {
  const titleRef = useRef<Form.TextField>(null);
  const bodyRef = useRef<Form.TextArea>(null);
  return (
    <Form
      enableDrafts
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save" onSubmit={(v: { title: string }) => showToast({ title: `Saved ${v.title}` })} />
          <Action title="Focus Body" shortcut={{ modifiers: ["cmd", "shift"], key: "b" }} onAction={() => bodyRef.current?.focus()} />
          <Action title="Reset Title" shortcut={{ modifiers: ["cmd", "shift"], key: "r" }} onAction={() => titleRef.current?.reset()} />
        </ActionPanel>
      }
    >
      <Form.Description title="Draft" text={`draft=${props.draftValues?.title ?? "none"}`} />
      <Form.TextField id="title" title="Title" defaultValue="Untitled" ref={titleRef} />
      <Form.TextArea id="body" title="Body" ref={bodyRef} />
    </Form>
  );
}
