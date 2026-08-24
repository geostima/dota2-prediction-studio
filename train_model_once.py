from dota_predictor_advanced import DotaPredictionV2, init_advanced_db


def main():
    init_advanced_db()
    predictor = DotaPredictionV2()

    predictor.refresh_reference_data()
    predictor.fetch_pro_matches(limit=800, max_workers=6)

    trained = predictor.train(min_matches=120)
    if trained:
        print("Training complete. Model state saved.")
    else:
        print("Training did not complete. Increase fetch limit or lower min_matches.")


if __name__ == "__main__":
    main()
