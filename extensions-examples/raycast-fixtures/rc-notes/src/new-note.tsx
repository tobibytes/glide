import { Action, ActionPanel, Form, Toast, showToast, useNavigation, Detail } from "@raycast/api";
import { FormValidation, useForm } from "@raycast/utils";
import { loadNotes, saveNotes } from "./storage";

interface Values {
  title: string;
  body: string;
  pinned: boolean;
  priority: string;
  due: Date | null;
  tags: string[];
}

function Saved({ title }: { title: string }) {
  return <Detail markdown={`# Saved\n\nYour note **${title}** was saved.`} />;
}

export default function Command() {
  const { push } = useNavigation();
  const { handleSubmit, itemProps } = useForm<Values>({
    initialValues: { priority: "normal", pinned: false, tags: [] },
    validation: { title: FormValidation.Required, body: (v) => (v && v.length > 200 ? "Keep it under 200 characters" : undefined) },
    async onSubmit(values) {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Saving note…" });
      const notes = await loadNotes();
      notes.push({ id: String(Date.now()), title: values.title, body: values.body ?? "", pinned: !!values.pinned, priority: values.priority, due: values.due ? values.due.toISOString() : null, tags: values.tags ?? [] });
      await saveNotes(notes);
      toast.style = Toast.Style.Success;
      toast.title = `Saved "${values.title}"`;
      push(<Saved title={values.title} />);
    },
  });

  return (
    <Form
      navigationTitle="New Note"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Note" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="About" text="Notes are stored with LocalStorage." />
      <Form.TextField title="Title" placeholder="What is it about?" {...itemProps.title} />
      <Form.TextArea title="Body" placeholder="Details" {...itemProps.body} />
      <Form.Separator />
      <Form.Checkbox label="Pin this note" {...itemProps.pinned} />
      <Form.Dropdown title="Priority" {...itemProps.priority}>
        <Form.Dropdown.Item value="low" title="Low" />
        <Form.Dropdown.Item value="normal" title="Normal" />
        <Form.Dropdown.Item value="high" title="High" />
      </Form.Dropdown>
      <Form.DatePicker title="Due" type={Form.DatePicker.Type.Date} {...itemProps.due} />
      <Form.TagPicker title="Tags" {...itemProps.tags}>
        <Form.TagPicker.Item value="work" title="Work" />
        <Form.TagPicker.Item value="home" title="Home" />
      </Form.TagPicker>
    </Form>
  );
}
