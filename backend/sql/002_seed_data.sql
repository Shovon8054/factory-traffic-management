INSERT INTO junctions (id, name)
VALUES ('A', 'Junction A');

INSERT INTO junction_queues (junction_id, direction, queue_count)
VALUES
    ('A', 'NORTH', 0),
    ('A', 'SOUTH', 0),
    ('A', 'EAST', 0),
    ('A', 'WEST', 0);