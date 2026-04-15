-- People photo storage bucket — public read, authenticated write
-- Used by the People tab drag-drop upload feature

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'people-photos',
  'people-photos',
  true,
  5242880,  -- 5MB
  ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Public read access
CREATE POLICY "Public read on people-photos"
ON storage.objects FOR SELECT
USING (bucket_id = 'people-photos');

-- Authenticated users can upload
CREATE POLICY "Auth upload to people-photos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'people-photos');

-- Users can delete their own uploads
CREATE POLICY "Owner delete on people-photos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'people-photos' AND owner = auth.uid());
