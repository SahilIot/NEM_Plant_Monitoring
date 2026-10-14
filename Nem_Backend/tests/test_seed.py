from sqlalchemy import func, select

from app.models import Asset, Reading, Variable
from seed import seed_demo_data


def test_demo_seed_is_repeatable_and_does_not_rewrite_existing_readings(client, monkeypatch):
    monkeypatch.setenv("DEMO_ROOT_NAME", "Test Demo Root")
    factory = client.app.state.session_factory
    with factory() as session:
        seed_demo_data(session)
        first_count = session.scalar(select(func.count()).select_from(Reading))
        first_times = session.scalars(select(Reading.recorded_at).order_by(Reading.id)).all()
        seed_demo_data(session)
        assert session.scalar(select(func.count()).select_from(Asset)) == 6
        assert session.scalar(select(func.count()).select_from(Variable)) == 10
        assert session.scalar(select(func.count()).select_from(Reading)) == first_count == 9
        assert session.scalars(select(Reading.recorded_at).order_by(Reading.id)).all() == first_times
        assert session.scalar(
            select(func.count()).select_from(Asset).where(Asset.is_demo.is_(True))
        ) == 6
