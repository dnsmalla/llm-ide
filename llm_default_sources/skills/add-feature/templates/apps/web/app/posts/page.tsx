"use client";

import { useEffect, useState } from "react";
import { Screen, Stack, Surface, Text, Button, Input } from "../../components/shared";
import { postsApi } from "../../services/posts-api";

export default function PostsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    postsApi.list().then(r => setItems(r.data)).catch(e => setErr(String(e.message)));
  }, []);

  const submit = async () => {
    setErr("");
    try {
      const res = await postsApi.create({ title, body });
      setItems([res.data, ...items]);
      setTitle(""); setBody("");
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <Screen>
      <Stack gap="l">
        <Text variant="h1">Posts</Text>
        <Surface elevation={1} radius="m">
          <Stack gap="s">
            <Text variant="h3">New post</Text>
            <Input label="Title" value={title} onChange={e => setTitle(e.target.value)} placeholder="What's on your mind?" />
            <Input label="Body"  value={body}  onChange={e => setBody(e.target.value)}  placeholder="(optional)" />
            {err && <Text role="danger" variant="bodySm">{err}</Text>}
            <Button variant="primary" onClick={submit} disabled={!title}>Post</Button>
          </Stack>
        </Surface>
        <Stack gap="m">
          {items.map(p => (
            <Surface key={p.id} elevation={1} radius="m">
              <Stack gap="xs">
                <Text variant="h3">{p.title}</Text>
                {p.body && <Text role="secondary">{p.body}</Text>}
                <Text role="tertiary" variant="caption">{new Date(p.createdAt).toLocaleString()}</Text>
              </Stack>
            </Surface>
          ))}
        </Stack>
      </Stack>
    </Screen>
  );
}
