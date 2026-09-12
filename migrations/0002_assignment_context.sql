-- Preserve the topic and task as presented, even after admin metadata edits.
ALTER TABLE arena_assignments ADD COLUMN motion_snapshot TEXT;
ALTER TABLE arena_assignments ADD COLUMN category_snapshot TEXT;
ALTER TABLE arena_assignments ADD COLUMN task_snapshot TEXT;
UPDATE arena_assignments SET
  motion_snapshot=(SELECT t.motion FROM matchups m JOIN responses r ON r.id=m.response_low JOIN topics t ON t.id=r.topic_id WHERE m.id=arena_assignments.matchup_id),
  category_snapshot=(SELECT t.category FROM matchups m JOIN responses r ON r.id=m.response_low JOIN topics t ON t.id=r.topic_id WHERE m.id=arena_assignments.matchup_id),
  task_snapshot=(SELECT r.task FROM matchups m JOIN responses r ON r.id=m.response_low WHERE m.id=arena_assignments.matchup_id);
