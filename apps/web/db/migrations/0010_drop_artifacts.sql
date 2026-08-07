-- PR 2 (contract): drop the legacy artifacts table.
-- After 0009 the views table no longer references artifacts, and the
-- application code only reads/writes shareables.
DROP TABLE artifacts;
