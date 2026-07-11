#!/bin/bash
docker exec -it ledger_postgres_test psql -U ledger_user -d postgres -c "
  DROP DATABASE IF EXISTS ledger_test_db;
  CREATE DATABASE ledger_test_db OWNER ledger_user;
"

npm run db:migrate:test

docker exec -i ledger_postgres_test psql -U ledger_user -d ledger_test_db \
  < database/triggers/003_immutability_triggers.sql

docker exec -i ledger_postgres_test psql -U ledger_user -d ledger_test_db \
  < database/triggers/008_partition_ledger_entries.sql

docker exec -i ledger_postgres_test psql -U ledger_user -d ledger_test_db \
  < database/triggers/010_add_platform_operating_cash_account.sql

npm run db:seed:test